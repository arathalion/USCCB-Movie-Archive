# Moderating submissions

The public [`/submit`](../src/pages/submit.astro) form is the only write path into
the archive. Submissions land in the `movie_submissions` table in D1 and appear
nowhere on the site until you promote them by hand.

There are two ways to work the queue: the **private admin page** (easiest) or
**`wrangler` on the command line** (no password needed, works from this machine).

## The admin page

**https://movie-archive-api.viacrusis14.workers.dev/admin**

Served by the Worker, not by the public site. That distinction matters: GitHub Pages
serves everything it hosts to the world, so a static admin page could hide the data
but never the page itself. Here the HTML sits behind the same check as the data.

Sign in with the password stored in the Worker secret `ADMIN_PASSWORD`:

```bash
cd worker
npx wrangler secret put ADMIN_PASSWORD --name movie-archive-api
```

**Until that secret is set, the whole `/admin` surface returns 503** — it fails
closed on purpose, so a missing secret can never mean "let everyone in."

What it does: lists submissions by status, and marks one accepted or rejected.
Accepting **only marks the row reviewed** — it does not put the film on the site.
See [Getting an accepted film onto the site](#getting-an-accepted-film-onto-the-site).

Security model, stated plainly: one shared password, exchanged for a signed
HttpOnly/Secure/SameSite=Strict session cookie that expires after 12 hours. Wrong
passwords are compared in constant time and answered after a delay. There is **no
MFA, no per-user accounts, and no revocation short of rotating the secret** — that
is proportionate for a single moderator on a hobby archive, and not more. If it ever
needs to be stronger, the upgrade is Cloudflare Access in front of a custom domain.

## Or use the CLI

Everything below runs from the `worker/` directory and needs `wrangler login` as
the Cloudflare account that owns the `movie-archive` database.

## How a submission flows

```
/submit form  →  POST /submit on the Worker  →  Turnstile verified server-side
              →  INSERT into movie_submissions (status='pending')
```

The captcha is checked **on the Worker**, never in the browser — a client-side
check is trivially bypassable. See `handleSubmit` in
[`worker/src/index.js`](../worker/src/index.js).

## Review the queue

```bash
cd worker
npx wrangler d1 execute movie-archive --remote --yes \
  --command "SELECT id, created_at, title, year, usccb_code, mpaa_rating,
                    submitter_name, source_url, explanation
               FROM movie_submissions
              WHERE status = 'pending'
              ORDER BY created_at;"
```

Add `--json` if you'd rather pipe it somewhere.

## Accept or reject

Mark the row either way so it leaves the queue:

```bash
npx wrangler d1 execute movie-archive --remote --yes --command "
  UPDATE movie_submissions
     SET status = 'accepted', reviewed_at = datetime('now'), reviewer = 'max'
   WHERE id = 42;"
```

Use `'rejected'` for the other case.

## Getting an accepted film onto the site

**This is the step that's easy to get wrong.** D1 backs the live API, but the
website's pages are static and built from `data/*.ndjson`. A row written straight
into D1 shows up in the API immediately and on the site *never*.

So `data/` stays canonical and D1 is a derived serving copy. Add the film to
`data/movies.ndjson`, then re-seed:

```bash
# from the repo root — one JSON object per line, same keys as existing rows.
# ids have gaps (they're the original archive ids); take max(id)+1, don't reuse
# a gap. slug is the permanent URL key and must be unique.

node scripts/build_d1_seed.mjs
cd worker && npx wrangler d1 execute movie-archive --remote --yes --file=seed.sql
```

Then commit the `data/` change and push — that triggers the Pages rebuild which
generates the new `/film/{slug}` page and refreshes `/browse-index.json`.

Re-seeding drops and recreates the content tables, which also rebuilds the FTS
index. `movie_submissions` is created with `IF NOT EXISTS` and is **not**
dropped, so the queue survives a re-seed.

## Spam

Turnstile is the only gate, and an unset `TURNSTILE_SECRET` makes the Worker
**skip verification entirely**. If the form starts attracting bots, check that
first:

```bash
cd worker && npx wrangler secret list
npx wrangler secret put TURNSTILE_SECRET     # from dash.cloudflare.com → Turnstile
```

The matching public site key is `PUBLIC_TURNSTILE_SITE_KEY` in the site's build
env. Both currently default to Cloudflare's always-pass **test** keys, so the
captcha is decorative until you set real ones.
