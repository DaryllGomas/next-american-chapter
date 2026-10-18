const MY_VOTES_KEY = 'nac-my-votes-v2';

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
  renderFixed();
  renderSeats();
  refreshTally();
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
    <article class="card seat" data-seat="${esc(s.id)}">
      <div class="card-top">
        <div class="role">${esc(s.seat)}</div>
        <span class="confidence ${s.confidence === 'clear' ? 'clear' : 'close'}">${s.confidence === 'clear' ? 'Clear pick' : 'Close call'}</span>
      </div>
      <div class="mission">${esc(s.mission)}</div>
      <ol class="candidates">
        ${s.candidates.map((c, i) => `
          <li>
            <button class="candidate" data-choice="c${i}" aria-pressed="false">
              <span class="cand-head">
                <span class="name">${esc(c.name)}</span>
                ${i === 0 ? '<span class="ai-pick" title="The pick Claude, ChatGPT and Grok agreed on">AI pick</span>' : ''}
                <span class="pct" data-pct="c${i}"></span>
              </span>
              <span class="bio">${esc(c.bio)}</span>
              ${c.evidence ? `<span class="evidence"><b>Best evidence:</b> ${esc(c.evidence)}</span>` : ''}
              <span class="bar"><span data-bar="c${i}"></span></span>
            </button>
          </li>`).join('')}
      </ol>
      <div class="actions">
        <button class="btn alt" data-choice="alt" aria-pressed="false">Someone else <span class="pct" data-pct="alt"></span></button>
      </div>
      <form class="alt-form" novalidate>
        <input name="altName" maxlength="80" placeholder="Who instead?" autocomplete="off" required>
        <textarea name="reason" maxlength="500" placeholder="Why them? What have they actually done?" required></textarea>
        <div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
        <button class="btn submit" type="submit">Submit suggestion</button>
      </form>
      <p class="your-vote" hidden></p>
      <div class="suggested" hidden></div>
    </article>`).join('');

  for (const card of document.querySelectorAll('[data-seat]')) {
    const seat = card.dataset.seat;
    markPressed(card, myVotes[seat]);
    for (const btn of card.querySelectorAll('[data-choice]')) {
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
    toast({ none: 'Vote removed.', alt: 'Suggestion counted. Thanks for the reason.' }[payload.choice] || 'Vote counted.');
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
    if (widgetId !== null) window.turnstile.remove(widgetId);
    widgetId = window.turnstile.render('#turnstile', {
      sitekey: siteKey,
      action: 'vote',
      appearance: 'interaction-only',
      execution: 'execute',
      callback: (t) => resolve(t),
      'error-callback': () => reject(new Error('Human check failed. Refresh and try again.')),
    });
    window.turnstile.execute(widgetId);
  });
}

async function refreshTally() {
  try {
    const { seats, updatedAt } = await fetch('/api/tally').then((r) => r.json());
    for (const card of document.querySelectorAll('[data-seat]')) {
      const t = seats[card.dataset.seat];
      if (!t) continue;
      const total = t.total || 0;
      for (const el of card.querySelectorAll('[data-pct]')) {
        const n = t.counts[el.dataset.pct] || 0;
        el.textContent = total ? `${Math.round((n / total) * 100)}%` : '';
      }
      for (const el of card.querySelectorAll('[data-bar]')) {
        const n = t.counts[el.dataset.bar] || 0;
        el.style.width = total ? `${(n / total) * 100}%` : '0';
      }
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
  for (const b of card.querySelectorAll('[data-choice]')) b.setAttribute('aria-pressed', String(b.dataset.choice === choice));
  const note = $('.your-vote', card);
  const seat = slate.seats.find((s) => s.id === card.dataset.seat);
  if (!choice || choice === 'none') {
    note.hidden = true;
    return;
  }
  const name = choice === 'alt' ? 'someone else' : seat.candidates[Number(choice.slice(1))]?.name;
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
