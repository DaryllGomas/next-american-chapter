// API for the vote page. Static files in public/ are served by the ASSETS binding.
import slate from '../public/slate.json';

const VOTABLE = new Set(slate.seats.map((s) => s.id));
// Valid choices per seat: one per listed candidate ('c0', 'c1', ...), plus 'alt' for someone else.
const CHOICES = Object.fromEntries(
  slate.seats.map((s) => [s.id, new Set([...s.candidates.map((_, i) => `c${i}`), 'alt'])])
);
const MAX_PER_IP_PER_SEAT_PER_DAY = 25; // households, offices and phone carriers share IPs
const MAX_PER_IP_PER_DAY = 400;
const ALT_MIN_BACKERS = 3; // a write-in joins the seat's list once this many different voters typed it (and one passed the sniff test)
const TALLY_CACHE_SECONDS = 30;
const MAX_FEEDBACK_PER_IP_PER_DAY = 10;
const COOKIE = 'nac_vid';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY });
      }
      if (url.pathname === '/api/tally' && req.method === 'GET') {
        return tally(req, env, ctx);
      }
      if (url.pathname === '/api/vote' && req.method === 'POST') {
        return vote(req, env);
      }
      if (url.pathname === '/api/feedback' && req.method === 'POST') {
        return feedback(req, env);
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
};

async function vote(req, env) {
  if (!sameOrigin(req)) return json({ error: 'bad origin' }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const { seat, choice, token, website } = body;
  if (website) return json({ ok: true }); // honeypot field: humans never see it
  if (!VOTABLE.has(seat)) return json({ error: 'unknown seat' }, 400);
  if (choice !== 'none' && !CHOICES[seat].has(choice)) return json({ error: 'bad choice' }, 400);

  let altName = '';
  let reason = '';
  if (choice === 'alt') {
    altName = clean(body.altName, 80);
    reason = clean(body.reason, 500);
    if (altName.length < 3) return json({ error: 'Add a name.' }, 400);
    if (/https?:|www\./i.test(altName + reason)) return json({ error: 'No links, please.' }, 400);
    // A new write-in needs a reason. Backing a write-in that's already on the board doesn't.
    if (reason.length < 15) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM alternatives WHERE seat = ?1 AND name_key = ?2')
        .bind(seat, nameKey(altName)).first();
      if (row.n < ALT_MIN_BACKERS) return json({ error: 'Add a short reason why.' }, 400);
    }
  }

  const ip = req.headers.get('CF-Connecting-IP') || '';
  if (!(await turnstileOk(env, token, ip))) {
    return json({ error: 'Human check failed. Refresh and try again.' }, 403);
  }

  // Voter identity is a random cookie id; clearing cookies gets a new one, which the IP caps bound.
  let vid = readCookie(req, COOKIE);
  const setCookie = !vid || !/^[0-9a-f-]{36}$/.test(vid);
  if (setCookie) vid = crypto.randomUUID();
  const voterHash = await sha256(`${env.HASH_SALT}|voter|${vid}`);
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = await sha256(`${env.HASH_SALT}|ip|${day}|${ip}`);
  const dayStart = Date.parse(day);

  // Taking a vote back: only possible for a browser that already voted, so no cap check needed.
  if (choice === 'none') {
    if (setCookie) return json({ ok: true, seat, choice });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE seat = ?1 AND voter_hash = ?2').bind(seat, voterHash),
      env.DB.prepare('DELETE FROM alternatives WHERE seat = ?1 AND voter_hash = ?2').bind(seat, voterHash),
    ]);
    return json({ ok: true, seat, choice });
  }

  const caps = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN seat = ?1 THEN 1 ELSE 0 END) AS seat_count,
       COUNT(*) AS day_count,
       SUM(CASE WHEN seat = ?1 AND voter_hash = ?3 THEN 1 ELSE 0 END) AS mine
     FROM votes WHERE ip_hash = ?2 AND created_at >= ?4`
  ).bind(seat, ipHash, voterHash, dayStart).first();
  // Changing your own vote doesn't count against the caps.
  if (!caps.mine && (caps.seat_count >= MAX_PER_IP_PER_SEAT_PER_DAY || caps.day_count >= MAX_PER_IP_PER_DAY)) {
    return json({ error: 'Too many votes from this network today. Try again tomorrow.' }, 429);
  }

  // New write-ins (with a reason) get an AI sniff test. Backing one that's already on the board doesn't need it.
  let approved = 0;
  if (choice === 'alt' && reason.length >= 15) {
    const verdict = await sniffTest(env, seatName(seat), altName, reason);
    if (verdict.ok === false) {
      return json({ error: `That write-in didn't pass the sniff test: ${verdict.why || "it doesn't look like a real, serious pick."}` }, 422);
    }
    approved = verdict.ok === true ? 1 : 0; // null means the AI was unavailable: keep it, but hide the reason until reviewed
  }

  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO votes (seat, voter_hash, ip_hash, choice, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (seat, voter_hash) DO UPDATE SET choice = ?4, ip_hash = ?3, created_at = ?5`
    ).bind(seat, voterHash, ipHash, choice, now),
  ];
  if (choice === 'alt') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO alternatives (seat, voter_hash, name, name_key, reason, approved, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?7, ?6)
         ON CONFLICT (seat, voter_hash) DO UPDATE SET name = ?3, name_key = ?4, reason = ?5, approved = ?7, created_at = ?6`
      ).bind(seat, voterHash, altName, nameKey(altName), reason, now, approved)
    );
  } else {
    stmts.push(env.DB.prepare('DELETE FROM alternatives WHERE seat = ?1 AND voter_hash = ?2').bind(seat, voterHash));
  }
  await env.DB.batch(stmts);

  const headers = {};
  if (setCookie) {
    headers['Set-Cookie'] = `${COOKIE}=${vid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
  }
  return json({ ok: true, seat, choice }, 200, headers);
}

async function feedback(req, env) {
  if (!sameOrigin(req)) return json({ error: 'bad origin' }, 403);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (body.website) return json({ ok: true }); // honeypot
  const text = clean(body.text, 1500);
  if (text.length < 10) return json({ error: 'Say a little more.' }, 400);
  if (/https?:|www\./i.test(text)) return json({ error: 'No links, please.' }, 400);
  const ip = req.headers.get('CF-Connecting-IP') || '';
  if (!(await turnstileOk(env, body.token, ip))) return json({ error: 'Human check failed. Refresh and try again.' }, 403);
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = await sha256(`${env.HASH_SALT}|ip|${day}|${ip}`);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ?1').bind(ipHash).first();
  if (n.n >= MAX_FEEDBACK_PER_IP_PER_DAY) return json({ error: 'Thanks! That\'s plenty for today.' }, 429);
  await env.DB.prepare('INSERT INTO feedback (ip_hash, text, created_at) VALUES (?1, ?2, ?3)').bind(ipHash, text, Date.now()).run();
  return json({ ok: true });
}

async function tally(req, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL('/api/tally', req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const [votes, alts, reasons] = await env.DB.batch([
    env.DB.prepare('SELECT seat, choice, COUNT(*) AS n FROM votes GROUP BY seat, choice'),
    env.DB.prepare(
      `SELECT seat, name_key, MIN(name) AS name, COUNT(*) AS n FROM alternatives
       GROUP BY seat, name_key HAVING n >= ?1 AND MAX(approved) = 1 ORDER BY n DESC`
    ).bind(ALT_MIN_BACKERS),
    env.DB.prepare(
      `SELECT seat, name, reason FROM alternatives WHERE approved = 1 ORDER BY created_at DESC LIMIT 200`
    ),
  ]);

  const seats = {};
  for (const id of VOTABLE) seats[id] = { counts: {}, total: 0, alternatives: [], reasons: [] };
  for (const r of votes.results) {
    const s = seats[r.seat];
    if (s) {
      s.counts[r.choice] = r.n;
      s.total += r.n;
    }
  }
  for (const r of alts.results) {
    const s = seats[r.seat];
    if (s && s.alternatives.length < 6) s.alternatives.push({ name: r.name, n: r.n });
  }
  for (const r of reasons.results) {
    const s = seats[r.seat];
    if (s && s.reasons.length < 5) s.reasons.push({ name: r.name, reason: r.reason });
  }

  const res = json({ seats, updatedAt: new Date().toISOString() }, 200, {
    'Cache-Control': `public, max-age=${TALLY_CACHE_SECONDS}`,
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function seatName(id) {
  return slate.seats.find((s) => s.id === id)?.seat || id;
}

// Workers AI screens write-ins. It's a sniff test, not a judgment of merit: voters decide merit.
// Returns { ok: true }, { ok: false, why }, or { ok: null } when the model can't be reached.
async function sniffTest(env, seat, name, reason) {
  if (!env.AI) return { ok: null };
  const prompt = [
    'You screen write-in suggestions on a public, nonpartisan civic voting page. People suggest who should fill a seat in a',
    'hypothetical U.S. administration and say why. Apply a light sniff test only; do not judge politics or merit.',
    'REJECT if the name is not a real, identifiable person (fictional characters, jokes, gibberish, pets, "me", celebrities',
    'clearly suggested as a joke), if it names a private individual who is not a public figure, if the reason is spam,',
    'harassment, slurs, threats, sexual content, or makes defamatory claims about anyone, or if the reason contains',
    'personal contact details. ACCEPT everything else, including people from any party or ideology and controversial figures.',
    `Seat: ${seat}`,
    `Suggested person: ${name}`,
    `Reason given: ${reason}`,
    'Reply with only JSON: {"ok": true} or {"ok": false, "why": "<under 15 words, polite, for the voter>"}',
  ].join('\n');
  try {
    const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 60,
      temperature: 0,
    });
    // Take the first {...} only; models sometimes add a second object or commentary.
    // Workers AI may hand back the JSON already parsed, as a string, or in OpenAI chat format.
    const raw = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    let v = typeof raw === 'object' ? raw : null;
    if (!v) {
      const m = String(raw).match(/\{[^{}]*\}/);
      v = m ? JSON.parse(m[0]) : null;
    }
    if (v && typeof v.ok === 'boolean') return { ok: v.ok, why: clean(v.why, 140) };
  } catch (err) {
    console.error('sniff test failed', err);
  }
  return { ok: null };
}

async function turnstileOk(env, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await r.json();
  return out.success === true && (!out.action || out.action === 'vote');
}

function sameOrigin(req) {
  const origin = req.headers.get('Origin');
  return !origin || origin === new URL(req.url).origin;
}

function clean(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function nameKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function readCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      ...headers,
    },
  });
}
