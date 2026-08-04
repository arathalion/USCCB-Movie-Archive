# USCCB Movie Reviews Archive

An archive of **13,205 film reviews** published by the USCCB Office for Film &
Broadcasting / Catholic News Service, covering **1905–2011**. Every review carries a
USCCB moral-suitability rating; most carry an MPAA rating and a capsule synopsis, and
1,619 carry a long-form review. ~12.3k films are enriched with TMDB posters and genres.

It is a **fixed historical dataset** — it ended in 2011 and does not grow, apart from
occasional moderated corrections.

**Live site:** https://arathalion.github.io/USCCB-Movie-Archive/
**Public API:** https://movie-archive-api.viacrusis14.workers.dev/rest/v1

## Architecture in one paragraph

The site is **Astro, statically built, on GitHub Pages**. The canonical data is
`data/*.ndjson`, **committed to this repo** — so the build needs no network, no database
and no credentials. A **Cloudflare Worker backed by D1** (`worker/`) serves the three
things a static file tree genuinely cannot: ranked full-text search, the `/query` SQL
editor, and `/submit`. It also serves the public read-only API.

> **Moved off Supabase, August 2026.** The free-tier project kept auto-pausing — and not
> for lack of traffic. A keep-alive had been pinging it successfully for weeks, and it
> still paused **4 days after a verified database read, twice**. Once paused, Supabase
> withdraws the project's DNS record, so the keep-alive could not even reach it to
> recover; every outage needed a human. Postgres was replaced by committed NDJSON (for
> the build) and D1 (for the live API), neither of which pauses.
>
> **The public API kept its contract** — same query dialect, resource and column names,
> response shapes, and `content-range` count header, and the old `apikey`/`Authorization`
> headers are still accepted. Callers only change the base URL. See
> [`docs/api.md`](docs/api.md).

## Quick start

```bash
npm install
cp .env.example .env
npm run dev        # site at http://localhost:4321
npm run build      # prebuild regenerates SQLite/CSV exports, then static site → dist/
npm run preview    # serve the built dist/ locally
```

Requires **Node ≥ 24** (CI uses Node 26). The site build works offline with no
credentials. To exercise search / `/query` / `/submit` locally, also run the API:

```bash
cd worker
npx wrangler d1 execute movie-archive --local --file=seed.sql   # first time only
npx wrangler dev --local                                        # http://127.0.0.1:8788
```

`seed.sql` is generated (and git-ignored): `node scripts/build_d1_seed.mjs`.

## How it works

**Data flow.** `data/*.ndjson` is canonical. Two things derive from it:

```
data/*.ndjson ──┬─→ Astro build ──→ static pages + /browse-index.json + SQLite/CSV downloads
                └─→ build_d1_seed.mjs ──→ seed.sql ──→ D1 ──→ Worker API
```

D1 is a **derived serving copy**, not a second source of truth. A row written straight
into D1 shows up in the API and never on the site. To add a film: edit
`data/movies.ndjson`, re-seed D1, commit, push.

**Pages.**

- **`/film/{slug}`** — one static page per film (13,205), pre-rendered at build time by
  `src/lib/db.js`. Shows poster, genre chips and a TMDB link when enriched.
- **`/`** (browse) — fetches `/browse-index.json` (884 KB, ~257 KB gzipped) once, then
  filters, sorts and pages **entirely in the browser**: USCCB/MPAA/genre/year filters, an
  A–Z letter bar on the article-aware `letter` bucket, sort, clickable rating chips.
  Filter state lives in the URL (`?q=&usccb=&letter=…`), so any view is shareable.
  This means **the homepage has no backend dependency at all**. Only typing a search
  query calls the Worker, because ranked search over review text needs FTS5.
- **`/query`** — read-only SQL editor. Posts to the Worker's
  `rpc/run_read_only_sql`, which enforces a single `SELECT`/`WITH` and a 1000-row cap.
- **`/submit`** — public suggestion form; see below.

**Downloads.** `scripts/export_sqlite.mjs` regenerates `public/movies_web.db` (legacy
`reviews` schema + FTS5) and a flat CSV on every `prebuild`, shipped under
`dist/downloads/`. Git-ignored; not read at runtime.

**`/llms.txt`** ([`public/llms.txt`](public/llms.txt)) is a machine-readable summary for
agents and tool builders — schema, operators, rating semantics, and a pointer to the bulk
downloads so nobody pages the API 14,000 times.

## Project layout

```
data/*.ndjson             CANONICAL data (movies, redirects, movie_tmdb, genres, …)
src/pages/                index (browse), film/[slug], query, submit, about,
                          browse-index.json.js (emits the client browse index)
src/lib/db.js             build-time reader over data/
src/lib/api.js            client-side Worker API helper
worker/src/index.js       Worker: REST API, run_read_only_sql, /submit
worker/src/postgrest.js   PostgREST query-string → SQLite translator
worker/schema.sql         D1 schema (mirrors the old Postgres shape)
scripts/build_d1_seed.mjs data/ → worker/seed.sql
scripts/export_sqlite.mjs data/ → SQLite + CSV downloads (prebuild)
scripts/dump_from_postgres.mjs  one-shot Supabase → data/ escape hatch (kept for provenance)
scripts/tmdb_match.py     TMDB enrichment pipeline
supabase/migrations/      historical schema record; nothing runs against it any more
source-archive/           raw .shtml provenance (a–z); git-ignored, unused by the build
```

## Configuration

Copy `.env.example` to `.env`. Both values are public and safe to ship to the browser.

| Var | Used by | Notes |
|---|---|---|
| `PUBLIC_API_BASE` | browser (search, `/query`, `/submit`) | Worker base URL. Defaults to `http://127.0.0.1:8788` for local dev. In CI it comes from the repo **variable** of the same name. |
| `PUBLIC_TURNSTILE_SITE_KEY` | browser (`/submit`) | Turnstile site key; defaults to Cloudflare's always-pass **test** key |

There are no secrets in the site build. The only secret anywhere is the Worker's
`TURNSTILE_SECRET`, set with `wrangler secret put`.

## Submissions & moderation

`/submit` lets anyone suggest a film or a correction. The form posts to the Worker's
`POST /submit`, which verifies the Cloudflare Turnstile token **server-side** before
inserting into `movie_submissions` with status `pending` — a browser-side check would be
trivially bypassable. Nothing appears on the site automatically.

Turnstile currently uses Cloudflare's **test** keys, which always pass, so the captcha is
decorative until you set real ones:

```bash
cd worker && npx wrangler secret put TURNSTILE_SECRET   # from dash.cloudflare.com → Turnstile
# then set PUBLIC_TURNSTILE_SITE_KEY in .env and as a repo variable
```

Review the queue with `wrangler`; there is no admin UI (the login-gated `/admin` SPA was
removed with the Supabase migration — D1 has no auth layer, and the queue had taken zero
submissions in its lifetime):

```bash
cd worker
npx wrangler d1 execute movie-archive --remote --yes \
  --command "SELECT id, created_at, title, year, submitter_name, explanation
               FROM movie_submissions WHERE status = 'pending' ORDER BY created_at;"
```

Full walkthrough, including how to promote a submission into the archive:
[`docs/moderation.md`](docs/moderation.md).

## Deploying

**The site** — push to `main`. `.github/workflows/deploy.yml` builds with Astro (Node 26)
and publishes to Pages on every push.

- **Settings → Pages → Source = GitHub Actions.**
- Add repo **variable** `PUBLIC_API_BASE` (Settings → Secrets and variables → Actions →
  Variables) pointing at the deployed Worker.
- The workflow sets `BASE_PATH=/<repo-name>/` automatically, so the project site works at
  `https://<user>.github.io/<repo>/`. For a root/custom domain, set `BASE_PATH=/`.
  All asset and link URLs go through `import.meta.env.BASE_URL`; preview a project-path
  build locally with `BASE_PATH=/your-repo/ npm run build`.

**The API** — from `worker/`:

```bash
npx wrangler deploy                                              # code only
node ../scripts/build_d1_seed.mjs                                # after a data/ change
npx wrangler d1 execute movie-archive --remote --yes --file=seed.sql
```

Re-seeding drops and recreates the content tables (which also rebuilds the FTS index).
`movie_submissions` is created with `IF NOT EXISTS` and is **not** dropped, so the
queue survives.

## Public API

Read-only JSON, no signup, no key, CORS open. The curated `public_movies_api` resource
gives one row per film with TMDB fields and a `genres[]` array:

```bash
BASE="https://movie-archive-api.viacrusis14.workers.dev/rest/v1"
curl "$BASE/public_movies_api?select=title,year,usccb_code,genres&usccb_code=eq.O&year=gte.2000&limit=5"
```

It speaks a subset of the [PostgREST](https://postgrest.org/) dialect — `select`, the
usual comparison/`in`/`is`/`ilike`/`cs` operators, `order` with nulls handling,
`limit`/`offset`, `Range`, and `Prefer: count=exact` → `content-range`. Full-text search
is `?search_tsv=wfts(english).vampire` on the `movies` resource.

Known gaps versus real PostgREST (embedded resources, `not.`/`or=`/`and=`) are listed in
**[`docs/api.md`](docs/api.md)**. Prefer the bulk `/downloads/` artifacts over crawling.

## TMDB enrichment

The enrichment **has already been run** (~12.3k films with posters, 19 genres). To
refresh it:

```bash
export TMDB_API_KEY="..."
python3 scripts/tmdb_match.py --input export/films.json --out tmdb_matches.csv
node scripts/apply_tmdb.mjs        # NOTE: written against Postgres; needs porting to data/
```

`TMDB_API_KEY` is script-time only and never ships to the client.

> ⚠️ `apply_tmdb.mjs` still writes to Supabase and has **not** been ported to the
> `data/*.ndjson` + D1 pipeline. Re-running enrichment needs that work first.

## History

Built as a static SQLite-in-browser site, migrated to Supabase over 8 phases during June
2026, then migrated off Supabase in August 2026 for the pausing reasons above. The
original plan lives at `~/.claude/plans/quirky-jumping-phoenix.md`.

| Phase | What | Status |
|---|---|---|
| 1–3 | Stabilize baseline; Supabase schema + import; regenerate SQLite/CSV from Postgres | ✅ |
| — | Rework: live Supabase browse + server-side `/query` (replaced the planned static browse and sql.js snapshot) | ✅ |
| 4 | Public `/submit` → Turnstile-verified Edge Function | ✅ |
| 5 | Filtering, sorting, shareable URL state, A–Z bar, rating chips | ✅ |
| 6 | TMDB enrichment (posters + genres) | ✅ ~12.3k films |
| — | Schema refactor: 1:1 `movie_tmdb`, separate `redirects` table | ✅ |
| 7 | Public read-only API | ✅ |
| 8 | Moderator admin SPA at `/admin` | ⛔ removed in 9 |
| 9 | **Migrate off Supabase** → committed NDJSON + Cloudflare Worker/D1 | ✅ |

One thread worth knowing: the original static browse was abandoned because GitHub Pages
gzips files and serves *compressed* byte ranges, which broke sql.js-httpvfs range
requests. Phase 9 made browse static again — but with a prebuilt JSON index the browser
loads whole, rather than range requests into a SQLite file, sidestepping that bug
entirely.

Not built: **featured films / movie-of-the-day** (manual daily/weekly picks plus an
automatic A-I/A-II pick); sketch is in the plan file.

---

Review text © its original publishers (USCCB / Catholic News Service). This archive is
unaffiliated with the USCCB. Poster and genre metadata from
[TMDB](https://www.themoviedb.org/); this product uses the TMDB API but is not endorsed
or certified by TMDB.
