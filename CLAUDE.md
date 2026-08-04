# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **Astro site deployed to GitHub Pages** for an archive of **13,205 USCCB / Catholic News Service movie reviews** (coverage **1905–2011**), plus a **Cloudflare Worker + D1** API. `README.md` documents the as-built site; `WEBSITE_BUILD_SPEC.md` is the original spec.

**`data/*.ndjson`, committed to this repo, is the single source of truth.** Static pages, the browse index, the SQLite/CSV downloads, and the D1 seed all derive from it. The site build needs **no network and no credentials**.

> **This project no longer uses Supabase** (migrated away 2026-08-03/04). Do not propose Supabase fixes, migrations, or RLS changes. The free-tier project kept auto-pausing *despite a verified-working keep-alive* — it paused 4 days after a successful DB read, twice — and a paused project loses its DNS record, so the keep-alive couldn't recover it. `supabase/migrations/` is kept only as a historical schema record; nothing runs against it.

Rendering: detail pages and browse are **static**; only full-text search, `/query` and `/submit` call the Worker.

## The invariant that's easiest to get wrong

**`data/` is canonical; D1 is a derived serving copy.** A row written straight into D1 appears in the API and *never* on the site. To add or edit a film:

```bash
# 1. edit data/movies.ndjson
node scripts/build_d1_seed.mjs
cd worker && npx wrangler d1 execute movie-archive --remote --yes --file=seed.sql
# 2. commit the data/ change and push → Pages rebuild regenerates the film page + browse index
```

Re-seeding drops and recreates content tables (rebuilding FTS). `movie_submissions` uses `IF NOT EXISTS` and is **not** dropped, so the queue survives.

## Repository layout

- `data/*.ndjson` — **canonical data**: `movies` (13,205), `redirects` (330), `movie_tmdb` (12,258), `genres` (19), `movie_genres` (27,961), `usccb_ratings` (6), `movie_submissions`. The generated `search_tsv` column is deliberately excluded (derived, ~16 MB, meaningless outside Postgres).
- `src/pages/` — `index.astro` (**static** browse: fetches `/browse-index.json` once, then filters/sorts/pages in the browser; calls the Worker *only* for full-text search), `film/[slug].astro` (one static page per film), `query.astro` (SQL editor → Worker `rpc/run_read_only_sql`), `submit.astro` (→ Worker `POST /submit`), `browse-index.json.js` (emits the compact client index), `about.astro`.
- `src/lib/` — `db.js` (build-time reader over `data/`; **resolves paths from `process.cwd()`, not `import.meta.url`** — Astro bundles it into `dist/.prerender/` before running `getStaticPaths`, so a module-relative path breaks the build), `api.js` (client-side Worker helper), `ratings.js` (USCCB legend).
- `worker/` — `src/index.js` (routes: REST API, `rpc/run_read_only_sql`, `/submit`), `src/postgrest.js` (PostgREST query-string → SQLite translator), `schema.sql`, `wrangler.toml`. `seed.sql` is generated and git-ignored.
- `scripts/` — `build_d1_seed.mjs` (`data/` → `worker/seed.sql`), `export_sqlite.mjs` (`data/` → SQLite + CSV downloads, runs on `prebuild`), `dump_from_postgres.mjs` (one-shot Supabase escape hatch, kept for provenance), `tmdb_match.py` / `apply_tmdb.mjs` (TMDB enrichment — **`apply_tmdb.mjs` still targets Supabase and needs porting to `data/` before it can run again**).
- `public/llms.txt` — machine-readable API summary for agents/tool builders.
- `docs/api.md` — public API reference, incl. a "Differences from PostgREST" table.
- `docs/moderation.md` — CLI moderation flow (the `/admin` SPA was removed).
- `.github/workflows/deploy.yml` — Pages deploy; Node 26, sets `BASE_PATH`, injects `PUBLIC_API_BASE` from a repo **variable**.

## The API (worker/)

Deployed at `https://movie-archive-api.viacrusis14.workers.dev`, D1 database `movie-archive` (`4d973dfd-4977-48e8-adb3-46dcfd809676`), on the **personal** Cloudflare account `viacrusis14@gmail.com` — deliberately not the Den & Burrow work account.

**It has an external consumer**, so `docs/api.md` is a contract, not just documentation. Supported: `select`, `eq neq gt gte lt lte like ilike in is cs`, `order` (incl. `nullsfirst`/`nullslast`), `limit`/`offset`, `Range`, `Prefer: count=exact` → `content-range`, and `search_tsv=wfts(english).…` on `movies` (tsvector → **FTS5**). Not supported: embedded resources, `not.`, `or=`, `and=`. `apikey`/`Authorization` headers are accepted and ignored so old callers keep working.

## Invariants to preserve

- **Never interpolate identifiers into SQL.** `postgrest.js` whitelists every resource/column/direction and binds all values. That whitelist *is* the injection guard.
- **`/query` validation is the only boundary.** D1 has no `transaction_read_only` and no `statement_timeout`, unlike the old Postgres RPC where the database itself refused writes. Keep the checks strict, and note two traps already fixed: `\bpragma\b` does **not** match `pragma_table_info` (underscore is a word char — use `pragma\w*`), and the denylist must skip string literals or honest queries like `where synopsis like '%update%'` get rejected.
- **Keep every rendered cell HTML-escaped** in `/query` — review text is untrusted (XSS).
- **Submissions:** `POST /submit` verifies Turnstile **server-side**. Don't move that to the client; the site key ships to the browser and a client check is bypassable. An unset `TURNSTILE_SECRET` makes the Worker **skip verification entirely**.
- **D1 caps a single SQL statement near 100 KB** (far tighter than SQLite's ~1 MB). `build_d1_seed.mjs` batches INSERTs by byte size, not row count — don't switch it back.
- **Redirects live in `redirects`**, not `movies`, so listings need no filter. `export_sqlite.mjs` UNIONs both to rebuild the legacy combined download.
- All client asset/link URLs go through `import.meta.env.BASE_URL` so the project-path deploy works. Don't hardcode leading-slash paths.
- `public/movies_web.db` and the CSV are **git-ignored derived artifacts** — never hand-edit, never commit.

## Data notes

`movies.id` values are the original archive ids and **have gaps** (removed redirects/placeholders); take `max(id)+1` for new rows rather than filling a gap. `slug` is the permanent URL contract. `letter` is the article-aware source-folder bucket ("The Bear" → `b`). `year` is ~3.6% null, `mpaa_rating` ~42% null, `full_review` present for 1,619 films.

USCCB legend: A-I general patronage · A-II adults and adolescents · A-III adults · A-IV adults with reservations · L limited adult audience · O morally offensive. These are **moral-suitability judgements, not quality ratings** — `O` means the reviewer judged the film morally offensive, not that it is a bad film.

`public/movies_web.db` keeps the **legacy** SQLite shape (single `reviews` table holding films + redirects with an `is_redirect` flag, `cns_rating`, `filename`, `reviews_fts`) for download compatibility — don't confuse it with `worker/schema.sql`.

## Commands

```bash
npm install
npm run dev          # dev server (search/query/submit need the Worker too, see below)
npm run build        # prebuild regenerates SQLite/CSV from data/, then static site → dist/
npm run export:db    # regenerate the SQLite/CSV exports only
npm run preview      # serve dist/ locally
BASE_PATH=/repo/ npm run build   # simulate a project-path GitHub Pages build

cd worker
npx wrangler dev --local                                       # API at 127.0.0.1:8788
npx wrangler d1 execute movie-archive --local  --file=seed.sql # seed local D1
npx wrangler d1 execute movie-archive --remote --file=seed.sql # seed production D1
npx wrangler deploy
```

Wrangler gotchas: `--callback-port` on `wrangler login` is broken (it moves the listener but not the OAuth redirect, which is always 8976), and a brand-new `*.workers.dev` subdomain serves plain HTTP for a few minutes before its TLS cert exists — handshake failures right after a first deploy are expected.

This is a fixed historical archive (ends 2011); the only expected new data is moderated public submissions.
