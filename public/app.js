const MY_VOTES_KEY = 'nac-my-votes-v2';
// Once a seat has this many votes, its list re-sorts by votes, so popular write-ins rise past the AI picks.
const RISE_AFTER_VOTES = 10;

const $ = (sel, el = document) => el.querySelector(sel);
// Same grouping as nameKey() in src/worker.js: "José  Andrés" matches "jose andres".
const nameKey = (n) => String(n).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let slate;
let siteKey;
let widgetId = null;
let myVotes = loadMyVotes();
// Fresh per-seat numbers from your own votes; they win over an older cached tally.
const fresh = {};

init();

async function init() {
  [slate, { turnstileSiteKey: siteKey }] = await Promise.all([
    fetch('slate.json').then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
  ]);
  if (slate.repo) $('#repo-link').href = slate.repo;
  renderSeats();
  refreshTally();
  $('#fb-form').addEventListener('submit', sendFeedback);
}

async function sendFeedback(e) {
  e.preventDefault();
  const f = e.target;
  const btn = $('button', f);
  btn.disabled = true;
  try {
    await post('/api/feedback', { text: f.text.value, website: f.website.value });
    f.reset();
    toast('Thanks. It goes into the next version.');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderSeats() {
  // "Who we call on" seats sit in their own section above the team; voting works the same.
  $('#call-on').innerHTML = slate.seats.filter((s) => s.group === 'call-on').map(seatCard).join('');
  $('#seats').innerHTML = slate.seats.filter((s) => !s.group).map(seatCard).join('');
  wireSeats();
}

function seatCard(s) {
  return `
    <article class="card seat" data-seat="${esc(s.id)}">
      <div class="card-top">
        <div class="role">${esc(s.seat)}</div>
        ${s.badge ? '' : `<span class="confidence ${s.confidence === 'clear' ? 'clear' : 'close'}">${s.confidence === 'clear' ? 'Clear pick' : 'Close call'}</span>`}
      </div>
      <div class="mission">${esc(s.mission)}</div>
      <ol class="candidates">
        ${s.candidates.map((c, i) => `
          <li>
            <button class="candidate" data-choice="c${i}" aria-pressed="false">
              <span class="cand-head">
                <span class="name">${esc(c.name)}</span>
                ${i === 0 ? `<span class="ai-pick" title="${s.badge ? 'Starting pick; voters can write in someone else' : 'The pick the AIs agreed on'}">${esc(s.badge || 'AI pick')}</span>` : ''}
                ${c.writeIn ? '<span class="write-in" title="Added to the ballot by voters\' write-ins">Write-in</span>' : ''}
                <span class="pct" data-pct="c${i}"></span>
              </span>
              <span class="bio">${esc(c.bio)}</span>
              ${c.evidence ? `<span class="evidence"><b>Best evidence:</b> ${esc(c.evidence)}</span>` : ''}
              <span class="bar"><span data-bar="c${i}"></span></span>
            </button>
          </li>`).join('')}
      </ol>
      <div class="actions">
        <button class="btn alt" data-choice="alt" aria-pressed="false" aria-expanded="false">✍️ Write in your own <span class="pct" data-pct="alt"></span></button>
      </div>
      <form class="alt-form" novalidate>
        <input name="altName" maxlength="80" placeholder="${esc(s.altPrompt || 'Who would you put in this seat?')}" aria-label="${esc(s.altPrompt || 'Who would you put in this seat?')}" autocomplete="off" required>
        <textarea name="reason" maxlength="500" placeholder="Why them? What have they actually done?" aria-label="Why them?"></textarea>
        <p class="form-note">Write-ins that enough people back get added to the ballot.</p>
        <div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
        <button class="btn submit" type="submit">Submit write-in</button>
      </form>
      <p class="your-vote" hidden></p>
      <div class="suggested" hidden></div>
    </article>`;
}

function wireSeats() {
  for (const card of document.querySelectorAll('[data-seat]')) {
    const seat = card.dataset.seat;
    markPressed(card, myVotes[seat]);
    for (const btn of card.querySelectorAll('[data-choice]')) {
      btn.addEventListener('click', () => {
        if (card.dataset.busy) return; // a vote on this seat is already on its way
        // Clicking your current choice again takes the vote back.
        if (btn.getAttribute('aria-pressed') === 'true') {
          openAltForm(card, false);
          submit(card, { seat, choice: 'none' });
        } else if (btn.dataset.choice === 'alt') {
          openAltForm(card, !$('.alt-form', card).classList.contains('open'));
        } else {
          openAltForm(card, false);
          submit(card, { seat, choice: btn.dataset.choice });
        }
      });
    }
    $('.alt-form', card).addEventListener('submit', (e) => {
      e.preventDefault();
      if (card.dataset.busy) return;
      const f = e.target;
      submit(card, { seat, choice: 'alt', altName: f.altName.value, reason: f.reason.value, website: f.website.value });
    });
  }
}

function openAltForm(card, open) {
  $('.alt-form', card).classList.toggle('open', open);
  $('[data-choice="alt"]', card).setAttribute('aria-expanded', String(open));
  if (open) $('.alt-form input', card).focus();
}

// Votes go one at a time, so a second click can't cancel the first one's human check.
let queue = Promise.resolve();
function submit(card, payload) {
  // Lock the seat right away, so a second tap while this one waits in line can't queue a conflicting vote.
  card.dataset.busy = '1';
  card.classList.add('pending');
  queue = queue.then(() => submitNow(card, payload));
  return queue;
}

// Try without a check first: one passed check covers the next 30 minutes of voting.
async function post(url, body) {
  const send = (token) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token ? { ...body, token } : body),
  });
  let res = await send();
  let out = await res.json().catch(() => ({}));
  if (res.status === 403 && out.needCheck) {
    res = await send(await humanCheck());
    out = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(out.error || 'Something went wrong.');
  return out;
}

async function submitNow(card, payload) {
  toast(payload.choice === 'none' ? 'Removing your vote…' : 'Counting your vote…');
  try {
    const out = await post('/api/vote', payload);
    if (payload.choice === 'none') delete myVotes[payload.seat];
    else myVotes[payload.seat] = payload.choice === 'alt' ? `alt:${payload.altName.trim()}` : payload.choice;
    saveMyVotes();
    if (out.tally) {
      fresh[payload.seat] = { t: out.tally, at: Date.now() };
      renderSeatTally(card, out.tally);
    }
    markPressed(card, myVotes[payload.seat]);
    openAltForm(card, false);
    toast({ none: 'Vote removed.', alt: `Write-in counted${payload.altName ? `: ${payload.altName}` : ''}.` }[payload.choice] || 'Vote counted.');
  } catch (err) {
    toast(err.message);
  } finally {
    delete card.dataset.busy;
    card.classList.remove('pending');
  }
}

// One Turnstile widget, and one check at a time: votes and feedback share it, and starting a new check
// would cancel one in progress.
let checking = Promise.resolve();
function humanCheck() {
  const run = checking.then(runCheck);
  checking = run.catch(() => {});
  return run;
}

function runCheck() {
  return new Promise((resolve, reject) => {
    if (!window.turnstile || !siteKey) return reject(new Error('Human check is still loading. Try again in a second.'));
    // Settle exactly once, and never leave the buttons stuck if Cloudflare goes quiet.
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      showCheck(false);
      fn(arg);
    };
    const fail = (msg) => done(reject, new Error(msg));
    const timer = setTimeout(() => fail('The human check timed out. Tap your choice again.'), 120000);
    if (widgetId !== null) window.turnstile.remove(widgetId);
    widgetId = window.turnstile.render('#turnstile', {
      sitekey: siteKey,
      action: 'vote',
      appearance: 'interaction-only',
      execution: 'execute',
      callback: (t) => done(resolve, t),
      'error-callback': () => fail('Human check failed. Refresh and try again.'),
      'expired-callback': () => fail('The human check expired. Tap your choice again.'),
      'timeout-callback': () => fail('The human check timed out. Tap your choice again.'),
      'unsupported-callback': () => fail('This browser can\'t run the human check. Try another browser.'),
      // Most people pass invisibly. When Cloudflare does need a click, show it front and center.
      'before-interactive-callback': () => showCheck(true),
    });
    window.turnstile.execute(widgetId);
  });
}

function showCheck(on) {
  $('#check').hidden = !on;
  if (on) $('#check .check-box').focus();
}

async function refreshTally() {
  try {
    const { seats, updatedAt } = await fetch('/api/tally').then((r) => r.json());
    const asOf = Date.parse(updatedAt);
    for (const card of document.querySelectorAll('[data-seat]')) {
      const mine = fresh[card.dataset.seat];
      const t = mine && mine.at > asOf ? mine.t : seats[card.dataset.seat];
      if (t) renderSeatTally(card, t);
    }
    $('#updated').textContent = `Tallies update when you vote or reload. Last update ${new Date(updatedAt).toLocaleTimeString()}.`;
  } catch {
    $('#updated').textContent = 'Live tallies are unavailable right now.';
  }
}

function renderSeatTally(card, t) {
  const total = t.total || 0;
  const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : '');
  // The write-in button counts only write-ins that aren't shown as their own rows, so the numbers add up to 100%.
  const onBoard = t.alternatives.reduce((sum, a) => sum + a.n, 0);
  const count = (choice) => (choice === 'alt' ? Math.max(0, (t.counts.alt || 0) - onBoard) : t.counts[choice] || 0);
  for (const el of card.querySelectorAll('[data-pct]')) el.textContent = pct(count(el.dataset.pct));
  for (const el of card.querySelectorAll('[data-bar]')) {
    el.style.width = total ? `${(count(el.dataset.bar) / total) * 100}%` : '0';
  }
  renderWriteIns(card, t);
  riseByVotes(card, t);
  const box = $('.suggested', card);
  box.hidden = !t.reasons.length;
  box.innerHTML = t.reasons.length
    ? `<b>Why people wrote them in:</b><ul>${t.reasons.map((r) => `<li><b>${esc(r.name)}</b>: ${esc(r.reason)}</li>`).join('')}</ul>`
    : '';
  markPressed(card, myVotes[card.dataset.seat]);
}

// Write-ins with enough backers join the seat's list as full rows that anyone can back with one tap.
function renderWriteIns(card, t) {
  const list = $('.candidates', card);
  list.querySelectorAll('.writein-row').forEach((li) => li.remove());
  const total = t.total || 0;
  for (const a of t.alternatives) {
    const li = document.createElement('li');
    li.className = 'writein-row';
    li.dataset.votes = a.n;
    li.innerHTML = `
      <button class="candidate" data-writein="${esc(a.name)}" aria-pressed="false">
        <span class="cand-head">
          <span class="name">${esc(a.name)}</span>
          <span class="write-in" title="Added by voters">Write-in</span>
          <span class="pct">${total ? `${Math.round((a.n / total) * 100)}%` : ''}</span>
        </span>
        <span class="bio">Written in by ${a.n} people. Tap to back them.</span>
        <span class="bar"><span style="width:${total ? (a.n / total) * 100 : 0}%"></span></span>
      </button>`;
    $('button', li).addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const seat = card.dataset.seat;
      if (card.dataset.busy) return;
      if (btn.getAttribute('aria-pressed') === 'true') submit(card, { seat, choice: 'none' });
      else submit(card, { seat, choice: 'alt', altName: a.name, reason: '' });
    });
    list.appendChild(li);
  }
}

// Sort the seat's list by votes once there's enough signal; the top row gets a "Leading" tag.
function riseByVotes(card, t) {
  const rows = [...$('.candidates', card).children];
  const votes = (li) => {
    if (li.classList.contains('writein-row')) return Number(li.dataset.votes) || 0;
    return t.counts[$('[data-choice]', li).dataset.choice] || 0;
  };
  const rising = (t.total || 0) >= RISE_AFTER_VOTES;
  const ranked = rows.map((li, i) => ({ li, v: votes(li), i })).sort((a, b) => (rising ? b.v - a.v : 0) || a.i - b.i);
  ranked.forEach(({ li }, rank) => {
    li.style.order = rank;
    li.classList.toggle('leading', rising && rank === 0 && ranked[0].v > 0);
  });
}

function markPressed(card, choice) {
  const writeIn = choice?.startsWith('alt:') ? choice.slice(4) : null;
  for (const b of card.querySelectorAll('[data-choice]')) {
    b.setAttribute('aria-pressed', String(b.dataset.choice === choice || (b.dataset.choice === 'alt' && !!writeIn)));
  }
  for (const b of card.querySelectorAll('[data-writein]')) {
    b.setAttribute('aria-pressed', String(!!writeIn && nameKey(b.dataset.writein) === nameKey(writeIn)));
  }
  const note = $('.your-vote', card);
  const seat = slate.seats.find((s) => s.id === card.dataset.seat);
  if (!choice || choice === 'none') {
    note.hidden = true;
    return;
  }
  const name = writeIn || (choice === 'alt' ? 'your write-in' : seat.candidates[Number(choice.slice(1))]?.name);
  note.hidden = false;
  note.textContent = `Your vote: ${name}. Tap it again to undo.`;
}

function loadMyVotes() {
  try { return JSON.parse(localStorage.getItem(MY_VOTES_KEY)) || {}; } catch { return {}; }
}
function saveMyVotes() {
  try { localStorage.setItem(MY_VOTES_KEY, JSON.stringify(myVotes)); } catch { /* private mode */ }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
