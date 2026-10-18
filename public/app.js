const LEAN_NAMES = { L: 'Left', C: 'Center', Ind: 'Independent', R: 'Right' };
const LEAN_ORDER = ['L', 'C', 'Ind', 'R'];
const MY_VOTES_KEY = 'nac-my-votes';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let slate;
let siteKey;
let widgetId = null;
let myVotes = loadMyVotes();

init();

async function init() {
  [slate, { turnstileSiteKey: siteKey }] = await Promise.all([
    fetch('slate.json').then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
  ]);
  if (slate.repo) $('#repo-link').href = slate.repo;
  renderLedger();
  renderFixed();
  renderSeats();
  renderCouncil();
  refreshTally();
}

function renderLedger() {
  const counts = Object.fromEntries(LEAN_ORDER.map((k) => [k, 0]));
  for (const s of slate.seats) counts[s.pick.lean] = (counts[s.pick.lean] || 0) + 1;
  const total = slate.seats.length;
  const colors = { L: 'var(--left)', C: 'var(--center)', Ind: 'var(--ind)', R: 'var(--right)' };
  $('#ledger').innerHTML = `
    <div class="ledger-bar">${LEAN_ORDER.map((k) => `<span style="width:${(counts[k] / total) * 100}%;background:${colors[k]}"></span>`).join('')}</div>
    <div class="ledger-keys">${LEAN_ORDER.map((k) => `<span><i style="background:${colors[k]}"></i>${LEAN_NAMES[k]} ${counts[k]}</span>`).join('')}</div>`;
}

function renderFixed() {
  $('#fixed').innerHTML = slate.fixed.map((f) => `
    <article class="card fixed-card">
      <div class="card-top"><div class="role">${esc(f.role)}</div><span class="lock" title="Set, not voted on">🔒</span></div>
      <h3 class="name">${esc(f.name)}</h3>
      <p class="why">${esc(f.why)}</p>
      <span class="lock">Set, not voted on</span>
    </article>`).join('');
}

function renderSeats() {
  $('#seats').innerHTML = slate.seats.map((s) => `
    <article class="card" data-seat="${esc(s.id)}">
      <div class="card-top"><div class="role">${esc(s.seat)}</div><span class="lean ${esc(s.pick.lean)}" title="${esc(LEAN_NAMES[s.pick.lean])}">${esc(s.pick.lean)}</span></div>
      <h3 class="name">${esc(s.pick.name)}</h3>
      <div class="mission">${esc(s.mission)}</div>
      <p class="why">${esc(s.pick.why)}</p>
      ${s.alternates?.length ? `<p class="alts">Also considered: ${s.alternates.map((a) => `<b>${esc(a.name)}</b> <span class="lean ${esc(a.lean)}">${esc(a.lean)}</span>`).join(', ')}</p>` : ''}
      <div class="bar"><span class="u"></span><span class="a"></span><span class="d"></span></div>
      <div class="counts"><span class="cu">👍 0</span><span class="ca">✋ 0 someone else</span><span class="cd">👎 0</span></div>
      <div class="actions">
        <button class="btn up" data-choice="up" aria-pressed="false">👍 Yes</button>
        <button class="btn alt" data-choice="alt" aria-pressed="false">Someone else</button>
        <button class="btn down" data-choice="down" aria-pressed="false">👎 No</button>
      </div>
      <form class="alt-form" novalidate>
        <input name="altName" maxlength="80" placeholder="Who instead?" autocomplete="off" required>
        <textarea name="reason" maxlength="500" placeholder="Why them? What have they actually done?" required></textarea>
        <div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
        <button class="btn submit" type="submit">Submit suggestion</button>
      </form>
      <div class="suggested" hidden></div>
    </article>`).join('');

  for (const card of document.querySelectorAll('[data-seat]')) {
    const seat = card.dataset.seat;
    markPressed(card, myVotes[seat]);
    for (const btn of card.querySelectorAll('.actions .btn')) {
      btn.addEventListener('click', () => {
        // Clicking your current choice again takes the vote back.
        if (btn.getAttribute('aria-pressed') === 'true') {
          $('.alt-form', card).classList.remove('open');
          submit(card, { seat, choice: 'none' });
        } else if (btn.dataset.choice === 'alt') {
          $('.alt-form', card).classList.toggle('open');
          $('.alt-form input', card).focus();
        } else {
          $('.alt-form', card).classList.remove('open');
          submit(card, { seat, choice: btn.dataset.choice });
        }
      });
    }
    $('.alt-form', card).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      submit(card, { seat, choice: 'alt', altName: f.altName.value, reason: f.reason.value, website: f.website.value });
    });
  }
}

function renderCouncil() {
  if (!slate.council?.length) return;
  $('#council-section').hidden = false;
  $('#council').innerHTML = slate.council.map((c) => `
    <article class="card">
      <h3 class="name">${esc(c.name)}</h3>
      <p class="why">${esc(c.why)}</p>
    </article>`).join('');
}

async function submit(card, payload) {
  const buttons = card.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const token = await humanCheck();
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, token }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Something went wrong.');
    if (payload.choice === 'none') delete myVotes[payload.seat];
    else myVotes[payload.seat] = payload.choice;
    saveMyVotes();
    markPressed(card, payload.choice);
    $('.alt-form', card).classList.remove('open');
    toast({
      none: 'Vote removed.',
      alt: 'Suggestion counted. Thanks for the reason.',
    }[payload.choice] || 'Vote counted. Click it again to take it back.');
    setTimeout(refreshTally, 1500);
  } catch (err) {
    toast(err.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// One Turnstile widget, re-run for each vote: tokens are single-use.
function humanCheck() {
  return new Promise((resolve, reject) => {
    if (!window.turnstile || !siteKey) return reject(new Error('Human check is still loading. Try again in a second.'));
    const opts = {
      sitekey: siteKey,
      action: 'vote',
      appearance: 'interaction-only',
      execution: 'execute',
      callback: (t) => resolve(t),
      'error-callback': () => reject(new Error('Human check failed. Refresh and try again.')),
    };
    if (widgetId === null) widgetId = window.turnstile.render('#turnstile', opts);
    else {
      window.turnstile.remove(widgetId);
      widgetId = window.turnstile.render('#turnstile', opts);
    }
    window.turnstile.execute(widgetId);
  });
}

async function refreshTally() {
  try {
    const { seats, updatedAt } = await fetch('/api/tally').then((r) => r.json());
    for (const card of document.querySelectorAll('[data-seat]')) {
      const t = seats[card.dataset.seat];
      if (!t) continue;
      const total = t.up + t.down + t.alt || 1;
      $('.bar .u', card).style.width = `${(t.up / total) * 100}%`;
      $('.bar .a', card).style.width = `${(t.alt / total) * 100}%`;
      $('.bar .d', card).style.width = `${(t.down / total) * 100}%`;
      $('.cu', card).textContent = `👍 ${t.up}`;
      $('.ca', card).textContent = `✋ ${t.alt} someone else`;
      $('.cd', card).textContent = `👎 ${t.down}`;
      const box = $('.suggested', card);
      if (t.alternatives.length || t.reasons.length) {
        box.hidden = false;
        box.innerHTML = `
          ${t.alternatives.length ? `<div><b>People are suggesting:</b> ${t.alternatives.map((a) => `${esc(a.name)} (${a.n})`).join(', ')}</div>` : ''}
          ${t.reasons.length ? `<ul>${t.reasons.map((r) => `<li><b>${esc(r.name)}</b>: ${esc(r.reason)}</li>`).join('')}</ul>` : ''}`;
      }
    }
    $('#updated').textContent = `Tallies refresh every 30 seconds. Last update ${new Date(updatedAt).toLocaleTimeString()}.`;
  } catch {
    $('#updated').textContent = 'Live tallies are unavailable right now.';
  }
}

function markPressed(card, choice) {
  for (const b of card.querySelectorAll('.actions .btn')) b.setAttribute('aria-pressed', String(b.dataset.choice === choice));
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
