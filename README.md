# The Balanced Ticket

**Not left. Not right. One country.** An open-source, AI-powered people's ticket for a hypothetical 2028–2032
administration. Vote on every seat, or write in your own.

**Vote:** https://next-american-chapter.next-american-chapter.workers.dev

> "My hope here is that we can find a common ground, break through any obstacles that may have kept us apart."
> Palmer Joss (Matthew McConaughey), *Contact*, 1997

## What this is

In October 2026, Matthew McConaughey posted a video asking people to consider independent candidates who could get both
parties working together. This project asks the next question: if there were an independent ticket, who should be on the
team?

- **The picks:** Claude, ChatGPT and Gemini each picked the strongest person for every seat, blind, judged only on track
  record: speed, skill with AI, results for people with the fewest opportunities, a clean record, readiness to serve
  through 2028–2032, and trust across differences. Party, gender and race were not scored. Where they agreed, that's the
  AI pick, with runners-up beside it. The whole process is in [`docs/how-we-got-here.md`](docs/how-we-got-here.md).
- **The lead:** McConaughey starts as the strong lead for president. Like every seat, it's open to write-ins.
- **The backer:** Elon Musk announced the America Party in 2025 and reportedly shelved it. In this scenario, he revives it
  to put an independent ticket on the ballot, with no government job and no say over appointments.
- **The people decide:** vote for any pick, or write in your own with a reason. An AI sniff test checks that each write-in
  is a real person with a real reason, without judging their politics. Names people keep writing in join the list and rise
  by votes. AI reviews the votes, write-ins and feedback periodically and updates the team.

Nobody named has endorsed this, agreed to a role, or been asked. It's an independent citizen project.

## Change the slate

The slate lives in [`public/slate.json`](public/slate.json). To propose a different pick, runner-up or seat, open a pull
request that edits it, and say why in the description, with sources. Every pull request is checked automatically and
reviewed before it's merged.

## How it works

| Piece | What |
|---|---|
| `public/` | The static page (`index.html`, `app.js`, `styles.css`), `slate.json`, and `img/` (banner and share image) |
| `src/worker.js` | Cloudflare Worker: `/api/vote`, `/api/tally`, `/api/feedback`, `/api/config`, the AI sniff test; serves `public/` for everything else |
| `schema.sql` | D1 (SQLite) tables: `votes`, `alternatives` (write-ins) and `feedback` |
| `wrangler.toml` | Worker config. Secrets are set with `wrangler secret put`, never committed |

Everything runs on Cloudflare's free plan: Workers, D1, Workers AI and Turnstile. Security headers (CSP, HSTS, no framing)
are set in `public/_headers` and on every API response.

### Anti-gaming (best effort, not bot-proof)

- Every vote needs a fresh **Cloudflare Turnstile** token, verified server side.
- **One vote per seat per browser**, using a random HttpOnly cookie. Voting again changes your vote.
- **Per-network caps:** 25 votes per seat and 400 votes in total per IP per day. Bots that clear cookies run into
  the cap, and households and offices still fit under it.
- **No raw IPs are stored**, only `sha256(salt + day + ip)`, which rotates daily.
- Honeypot field, same-origin check, length limits, no links in suggestions.
- Suggested names show only once **3 different voters** typed the same name. Reasons show only after approval.

If it gets gamed, tighten the caps, require Turnstile's non-interactive challenge, or add a sign-in. Change it
and say so on the page.

## Run it locally

```bash
cp .dev.vars.example .dev.vars          # Cloudflare's always-pass Turnstile test keys
npx wrangler d1 execute next-american-chapter --local --file schema.sql
npx wrangler dev                        # http://localhost:8787
```

## Deploy (Cloudflare, free)

One time:

```bash
npx wrangler login
npx wrangler d1 create next-american-chapter      # put the database_id in wrangler.toml
npx wrangler d1 execute next-american-chapter --remote --file schema.sql
# Cloudflare dashboard > Turnstile > Add widget (managed) for the site's hostname,
# then put the site key in wrangler.toml [vars] TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put HASH_SALT               # long random string, e.g. `openssl rand -hex 32`
```

Then `npx wrangler deploy`.

After the first deploy, set the share image tags (`og:image`, `twitter:image` in `public/index.html`) to the full live
URL, e.g. `https://<host>/img/og.jpg`. X ignores relative image URLs.

## Write-ins

Anyone can write in their own pick for any seat, with a reason. Each new write-in gets an AI sniff test (Workers AI,
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`): it must be a real, identifiable public person, with a reason that isn't spam,
abuse or defamation. Politics and merit aren't judged. Passing reasons show on the seat right away. If the AI is
unavailable, the write-in is kept but its reason stays hidden until reviewed. Once 3 different people write in the same name (case and
spacing don't matter), it shows on that seat's "Top write-ins" board and others can back it with one tap, no reason needed.

When a write-in has strong support, put it on the ballot:

```bash
scripts/write-ins.py list --min 25                       # top write-ins on the live site
scripts/write-ins.py promote treasury "Jane Doe" --bio "Two short, sourced sentences." --dry-run
scripts/write-ins.py promote treasury "Jane Doe" --bio "..."  # adds her to slate.json, converts her write-in votes
npx wrangler deploy
```

Promoted people get a "Write-in" badge, and everyone who wrote them in keeps their vote. Check the bio before you promote.

## Feedback and the AI digest

The "Make it better" box stores open feedback (not shown on the page). To fold what people said into the next version:

```bash
scripts/export-feedback.py > feedback-export.md   # votes, write-ins with reasons, and all feedback
```

Paste it into ChatGPT, Claude or Grok and ask for a seat-by-seat summary of what people want changed.

## Weekly AI review

`scripts/weekly-review.sh` runs every Monday at 09:00 on the maintainer's machine (systemd user timer
`balanced-ticket-review.timer`). It exports votes, write-ins and feedback, has Claude write a short digest (who's leading,
write-ins with momentum, feedback themes, proposed updates, signs of vote stuffing), and saves it locally. Nothing on the
live site changes automatically: proposed updates go through a normal pull request.

## Moderate write-in reasons

```bash
# See pending reasons
npx wrangler d1 execute next-american-chapter --remote --command \
  "SELECT seat, name, reason, voter_hash FROM alternatives WHERE approved = 0 ORDER BY created_at DESC LIMIT 50"
# Approve one
npx wrangler d1 execute next-american-chapter --remote --command \
  "UPDATE alternatives SET approved = 1 WHERE seat = 'vp' AND voter_hash = '<hash>'"
```

Remove anything defamatory, personal, spammy or with contact details.

## Where it runs

- Live: Cloudflare Worker `next-american-chapter` with D1 database `next-american-chapter`.
- Source of truth: this repository. `main` only changes through reviewed pull requests that pass the `check` workflow.

## The banner

`public/img/banner.{webp,jpg}` is the dawn header made with ChatGPT on 2026-10-18 (the "Meeting Ground"
direction, plus a rising sun and a boat on the river). The original 2048×768 PNG is in `docs/design/`. `img/og.jpg` is a
1200×630 center crop used as the share card on X. Phones get a centered crop of the banner so the title stays readable.
