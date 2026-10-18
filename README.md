# The Balanced Ticket

**A hypothetical, cross-partisan team for America's next chapter. Not left, not right. The public votes on every seat.**

It started when Matthew McConaughey posted a video (October 2026) arguing for independents who can force
Democrats and Republicans to work together. The question: if he were president, who would be on the team to
deliver AI, energy, healthcare, education and real opportunity for the people who get left behind?

Claude and ChatGPT argued it out and landed on a starting slate. Now it's yours:

- **Two seats are set:** Matthew McConaughey (president) and Elon Musk (outside backer, no government role).
- **Every other seat is open:** thumbs up, thumbs down, or suggest someone else and say why.
- **Balance is the point.** The lean of every pick is labeled, and the ledger at the top shows the mix.

Nobody named has endorsed this, agreed to a role, or been asked. It's an independent citizen project.

## Change the slate

The slate lives in [`public/slate.json`](public/slate.json). To propose a different pick, alternate or seat, open a
pull request that edits it, and say why in the description. The two set seats aren't up for change.

## How it works

| Piece | What |
|---|---|
| `public/` | The static page (`index.html`, `app.js`, `styles.css`), `slate.json`, and `img/` (banner and share image) |
| `src/worker.js` | Cloudflare Worker: `/api/vote`, `/api/tally`, `/api/config`; serves `public/` for everything else |
| `schema.sql` | D1 (SQLite) tables: `votes` and `alternatives` |
| `wrangler.toml` | Worker config. Secrets are set with `wrangler secret put`, never committed |

Everything runs on Cloudflare's free plan: Workers, D1 and Turnstile.

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

## Moderate suggestions

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

- Code: `~/Projects/sites/next-american-chapter` on thor.
- Live: Cloudflare Worker `next-american-chapter` (not deployed yet).
- GitHub: `DaryllGomas/next-american-chapter` (public, not created yet).
- Background: the ChatGPT thread "McConaughey Administration Plan" and the Claude/ChatGPT back-and-forth that
  produced the slate.

## The banner

`public/img/banner.{webp,jpg}` is the dawn header Daryll made with ChatGPT on 2026-10-18 (the "Meeting Ground"
direction, plus a rising sun and a boat on the river). The original 2048×768 PNG is in `docs/design/`. `img/og.jpg` is a
1200×630 center crop used as the share card on X. Phones get a centered crop of the banner so the title stays readable.
