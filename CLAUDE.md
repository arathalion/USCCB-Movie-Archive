# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **built Astro static site** for an archive of **13,694 USCCB / Catholic News Service movie reviews** (coverage **1905–2011**). `WEBSITE_BUILD_SPEC.md` is the original spec; `README.md` documents the as-built site. The **SQLite database is the single source of truth** — everything else (static pages, exports) derives from it.

Two deliberate deviations from the spec, both documented in `README.md`:
- Build-time DB reads use Node's built-in **`node:sqlite`** (Node ≥ 24), not `better-sqlite3` — avoids compiling a native module.
- Browse search filters a build-generated `films-index.json` with plain client-side JS, not MiniSearch.

## Repository layout

- `public/movies_web.db` — **the shipped DB and source of truth.** 4096-byte pages + a `reviews_fts` FTS5 index. Read at build time *and* served at the site root (committed normally, never Git LFS). Living in `public/` is what makes both true at once.
- `public/{sqlite.worker.js,sql-wasm.wasm}` — copied from `node_modules/sql.js-httpvfs` by `scripts/copy-sqljs.mjs`, which runs automatically on `predev`/`prebuild`. **Don't hand-edit**; they're regenerated.
- `src/pages/` — `index.astro` (browse), `film/[slug].astro` (one static page per non-redirect film), `query.astro` (in-browser SQL), `about.astro`, and `films-index.json.js` (the slim browse index endpoint).
- `src/lib/` — `db.js` (`node:sqlite`, anchored to `process.cwd()` — **not** `import.meta.url`, which breaks once Astro relocates the module at build), `films.js` (id→slug map from `export/films.json`), `ratings.js` (USCCB legend).
- `export/` — data exports for a *separate* site. The site only uses `export/films.json` (for slugs); the rest (`reviews/`, CSV, NDJSON) is not consumed here.
- `data/movies.db` — original pre-FTS DB, not shipped. `apply_tmdb.py` writes `tmdb_id` here by default.
- `scripts/` — `copy-sqljs.mjs` plus the optional `tmdb_match.py` / `apply_tmdb.py` enrichment pipeline.
- `source-archive/a/` … `z/` — raw `.shtml` provenance (167 MB). **Git-ignored**, not used by the site or build.
- `.github/workflows/deploy.yml` — GitHub Pages deploy; sets `BASE_PATH=/<repo>/` (Node 26).

## Database schema (`movies_web.db`)

Table `reviews` (one row per film, ids 1–13694):

`id` (PK), `title`, `year` (~3.6% null), `cns_rating` (USCCB: A-I/A-II/A-III/A-IV/L/O, nullable), `mpaa_rating` (~42% null), `synopsis` (capsule), `full_review` (long-form, present for 1,619 films; paragraphs split by blank lines), `letter` (a–z source folder), `filename` (UNIQUE, original archive path), `is_redirect` (1 = "see other title" stub, 322 rows — **always exclude from listings**).

> `tmdb_id` is **not** a column in `public/movies_web.db` — `apply_tmdb.py` only adds it to `data/movies.db`. The detail page deliberately does not SELECT `tmdb_id` (it would error). To enable posters, add the column to the shipped DB first.

Indexes: `idx_title`, `idx_year`, `idx_cns`, `idx_mpaa`. FTS5 table `reviews_fts` (porter+unicode61) over `title`, `synopsis`, `full_review`, keyed by `rowid` = `reviews.id`. Text-search pattern:

```sql
SELECT r.title, r.year FROM reviews_fts f JOIN reviews r ON r.id = f.rowid
WHERE reviews_fts MATCH 'vampire' AND r.is_redirect = 0 ORDER BY rank LIMIT 100;
```

USCCB rating legend: A-I general patronage · A-II adults and adolescents · A-III adults · A-IV adults with reservations (treat as L) · L limited adult audience · O morally offensive.

## Field-shape gotcha (exports)

The same rating values appear under **three different shapes** across files: nested `ratings.usccb` / `ratings.mpaa` in `films.json`; flat `cns_rating` / `mpaa_rating` in `films_full.csv` and `.ndjson`; flat `usccb_rating` / `mpaa_rating` in `reviews/{id}.json` and the DB column `cns_rating`. All mean the USCCB classification.

## Commands

```bash
npm install        # approve esbuild/sharp install scripts if prompted (needed for the build)
npm run dev        # dev server (runs copy-sqljs first)
npm run build      # static site → dist/ (~13,375 pages, a few seconds)
npm run preview    # serve dist/ locally; supports range requests
BASE_PATH=/repo/ npm run build   # simulate a project-path GitHub Pages build
```

Quick data inspection (build-time DB lives in `public/`):

```bash
python3 -c "import sqlite3; c=sqlite3.connect('public/movies_web.db'); print(c.execute('SELECT COUNT(*) FROM reviews WHERE is_redirect=0').fetchone())"
```

TMDB enrichment (optional, needs `pip install requests` and a free TMDB v3 key or v4 token):

```bash
export TMDB_API_KEY="..."
python3 scripts/tmdb_match.py --input export/films.json --out tmdb_matches.csv   # resumable
python3 scripts/apply_tmdb.py --db data/movies.db                                # idempotent; --include-low for weak matches
```

`tmdb_match.py` is resumable (skips ids already in the CSV). `apply_tmdb.py` is idempotent. Status values: `matched`, `low_confidence`, `no_result`, `skipped_redirect`.

## Invariants to preserve

- **Exclude `is_redirect = 1`** from every listing/index (the 322 "see other title" stubs).
- **`public/movies_web.db` is committed normally — never Git LFS** (Pages won't serve LFS over its CDN, breaking range requests). Same for the worker/wasm: they must serve at the site root.
- All client asset URLs (DB, wasm, worker, `films-index.json`, links) go through `import.meta.env.BASE_URL` so the project-path deploy works. Don't hardcode leading-slash paths.
- `/query` is read-only by design: single `SELECT`/`WITH` only; PRAGMA/ATTACH/writes/multiple statements rejected; missing `LIMIT` auto-appended; rendered rows capped (~1000); **every cell HTML-escaped** (review text is untrusted → XSS). Keep these guards if you touch `query.astro`.
- `requestChunkSize` must stay **4096** (matches the DB page size).
- TMDB API key is build-time only — never ship it to the client.

This is a fixed historical archive (ends 2011); no data updates are expected.
