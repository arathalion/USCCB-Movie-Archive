# USCCB Movie Reviews Archive

A self-contained static website for an archive of **13,694 USCCB / Catholic News
Service movie reviews** (coverage **1905–2011**). The SQLite database is the single
source of truth: browse and detail pages are generated statically at build time, and
a power-user `/query` page runs arbitrary read-only SQL **entirely in the browser**
via HTTP range requests — no backend, no server, no database service.

## Quick start

```bash
npm install        # also approves esbuild/sharp install scripts if prompted
npm run dev        # local dev server at http://localhost:4321
npm run build      # static site → dist/
npm run preview    # serve the built dist/ locally (supports range requests)
```

Requires **Node ≥ 24** (build-time DB reads use the built-in `node:sqlite`; verified
on Node 26).

## How it works

- **Source of truth:** `public/movies_web.db` (~23 MB, 4096-byte pages + an FTS5
  full-text index). It is committed to the repo and served at the site root.
- **Browse (`/`)** loads a slim, build-generated `films-index.json` and filters/searches
  client-side. **Detail pages (`/film/{slug}`)** are pre-rendered from the DB at build
  time — one static page per non-redirect film. **`/query`** loads the DB in the browser
  with `sql.js-httpvfs`, fetching only the pages each query touches.
- The build reads the DB with Node's **`node:sqlite`** (no native module to compile —
  this is a deliberate substitution for the `better-sqlite3` the original spec named).
- URL **slugs** come from `export/films.json` (stable + unique).

## Project layout

```
public/movies_web.db        # shipped DB (source of truth); served at site root
public/sqlite.worker.js     # copied from sql.js-httpvfs by scripts/copy-sqljs.mjs
public/sql-wasm.wasm        #   (pre{dev,build} step) — do not edit by hand
src/pages/                  # index (browse), film/[slug], query, about, films-index.json
src/lib/                    # db.js (node:sqlite), films.js (slug map), ratings.js
export/                     # data exports for a separate site; films.json is used here for slugs
scripts/                    # copy-sqljs.mjs; tmdb_match.py / apply_tmdb.py (optional TMDB enrichment)
data/movies.db              # original pre-FTS DB (not shipped)
source-archive/             # raw .shtml provenance (a–z); git-ignored, not used by the site
```

## Deploying to GitHub Pages

1. Create a repo and push this folder to `main`. `public/movies_web.db` is committed
   **normally — never via Git LFS** (Pages does not serve LFS over its CDN, which would
   break range requests).
2. In **Settings → Pages**, set **Source = GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` builds with Astro and publishes on
   every push to `main`. It sets `BASE_PATH=/<repo-name>/` automatically, so the site
   works at `https://<user>.github.io/<repo>/`.
   - For a **user/root site** (`<user>.github.io`) or a **custom domain at the root**,
     change `BASE_PATH` in the workflow to `/`.

Local builds default to base `/`. To preview a project-path build locally:
`BASE_PATH=/your-repo/ npm run build`.

## Optional: TMDB posters

`public/movies_web.db` has no `tmdb_id` column. To add posters, run the enrichment
scripts (see `scripts/` and `CLAUDE.md`), add a `tmdb_id` column to the shipped DB, and
extend `src/pages/film/[slug].astro` to render the poster when the id is present. The
TMDB API key must stay build-time only — never ship it to the client.
