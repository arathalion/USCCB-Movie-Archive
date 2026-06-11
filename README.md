# USCCB Movie Reviews Archive

An archive of **13,371 USCCB / Catholic News Service movie reviews** (coverage
**1905–2011**). The public site is built with **Astro** and deployed to **GitHub
Pages**; the data lives in **Supabase Postgres**, which is the single source of
truth. Detail pages are pre-rendered at build time from Postgres, while browse and
SQL run live against Supabase from the browser.

> Migrated from the original static SQLite-in-browser site to a Supabase backend.
> Phases 1–7 are done (live browse/query, submissions, filtering, TMDB enrichment,
> schema refactor, public API); only the optional phase 8 admin SPA remains.
> See [Status & phases](#status--phases) below.

## Quick start

```bash
npm install        # also approves esbuild/sharp install scripts if prompted
cp .env.example .env   # values are public (anon key); fine to commit-as-template
npm run dev        # local dev server at http://localhost:4321
npm run build      # prebuild regenerates the SQLite/CSV exports, then static site → dist/
npm run preview    # serve the built dist/ locally
```

Requires **Node ≥ 24** (CI uses Node 26). The build reads Supabase at build time, so
`SUPABASE_URL` / `SUPABASE_ANON_KEY` must be set (via `.env` locally, repo secrets in
CI). These are the public anon/publishable values — no secret is needed to build.

## How it works

- **Source of truth:** Supabase Postgres (project `vjtavurzjxfjczpvtpdq`). The `movies`
  table holds one row per real film (13,371), with a generated `search_tsv` tsvector for
  full-text search. TMDB enrichment is a 1:1 `movie_tmdb` table; the 322 "see other title"
  alias stubs are a separate `redirects` table (so `movies` needs no `is_redirect` filter).
  Plus `usccb_ratings`, `genres`/`movie_genres`, and the submission/moderation tables.
- **Detail pages (`/film/{slug}`)** are pre-rendered at build time — one static page
  per non-redirect film (~13,371). `src/lib/db.js` reads Postgres with `supabase-js`
  (anon key), paginating past PostgREST's 1000-row cap and embedding each film's genres.
  When a film has TMDB data, the page also shows its poster, genre chips, and a TMDB link.
- **Browse (`/`)** runs **live in the browser**: full-text `textSearch` on `search_tsv`
  plus USCCB/MPAA/year filters, an A–Z letter bar (on the article-aware `letter` bucket),
  sort, clickable rating chips, and "show more" pagination — all querying Supabase directly
  with the public anon key. Filter state is reflected in the URL (`?q=&usccb=&letter=…`), so
  any view is shareable and bookmarkable.
- **Submit (`/submit`)** lets anyone suggest a film. The form calls the `submit-movie`
  **Edge Function**, which verifies a Cloudflare Turnstile token server-side and inserts
  the row (status `pending`) via the service role — direct anon INSERT is revoked, so the
  function is the only write path. Moderators review the queue in Supabase Studio.
- **`/query`** is a **server-side read-only SQL editor**. The browser calls the
  `run_read_only_sql()` Postgres function (SECURITY INVOKER → anon RLS + grants apply):
  a single `SELECT`/`WITH` only, read-only transaction, 5-second statement timeout,
  1000-row cap. Queries hit the Postgres `movies` schema.
- **SQLite + CSV** are **derived build artifacts**, regenerated from Postgres by
  `scripts/export_sqlite.mjs` on every `prebuild` and shipped under `dist/downloads/`
  for download. They are git-ignored and no longer read at runtime.
- **URL slugs** are stored on each `movies` row (the stable, unique URL contract).

## Project layout

```
src/pages/                  # index (live browse), film/[slug] (static detail), query (SQL), about
src/lib/                    # db.js (supabase-js build-time reader), ratings.js (USCCB legend)
supabase/migrations/        # schema, indexes, RLS, run_read_only_sql, anon-grant hardening
scripts/import_to_postgres.mjs   # one-time data load into Postgres (service-role key)
scripts/export_sqlite.mjs        # regenerate public/movies_web.db + CSV FROM Postgres (prebuild)
scripts/tmdb_match.py, apply_tmdb.py   # optional TMDB enrichment pipeline (Phase 6)
export/films.json           # original exports for a separate site (not used by this build)
data/movies.db              # original pre-FTS SQLite (not shipped)
source-archive/             # raw .shtml provenance (a–z); git-ignored, not used by the site
```

## Configuration

Copy `.env.example` to `.env`. Keys:

| Var | Used by | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | build (`db.js`) | public anon values; read-only |
| `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` | browser (browse + `/query`) | Astro inlines `PUBLIC_*` into the client bundle |
| `PUBLIC_TURNSTILE_SITE_KEY` | browser (`/submit`) | Cloudflare Turnstile site key; defaults to Cloudflare's always-pass test key |
| `SUPABASE_SERVICE_ROLE_KEY` | `scripts/import_to_postgres.mjs` only | **secret** — bypasses RLS; never commit, never ship to the client |

In CI, the public values come from repo secrets `SUPABASE_URL` / `SUPABASE_ANON_KEY`
(and optionally `TURNSTILE_SITE_KEY`); see `.github/workflows/deploy.yml`.

### Public submissions (Phase 4)

`/submit` works out of the box with Cloudflare's **test** Turnstile keys (the widget
always passes). To enable real bot protection in production:

1. Create a free **Cloudflare Turnstile** widget (dash.cloudflare.com → Turnstile),
   adding your site's domain. You get a **site key** (public) and a **secret key**.
2. Set the secret on the Edge Function:
   `supabase secrets set TURNSTILE_SECRET=<secret-key>` (or Dashboard → Edge Functions →
   `submit-movie` → Secrets).
3. Publish the site key: set `PUBLIC_TURNSTILE_SITE_KEY` in `.env` and add a
   `TURNSTILE_SITE_KEY` repo secret for CI.

The `submit-movie` Edge Function (`supabase/functions/submit-movie/`) is the only write
path to `movie_submissions`; deploy changes with `supabase functions deploy submit-movie`.
Moderate the `pending` queue in Supabase Studio (set `status`, write `admin_notes`,
link `linked_movie_id`; an `after`/`before update` trigger logs review events).

## Deploying to GitHub Pages

1. Push to `main`. `.github/workflows/deploy.yml` builds with Astro (Node 26) and
   publishes on every push.
2. In **Settings → Pages**, set **Source = GitHub Actions**.
3. Add repo secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` (public anon values) under
   **Settings → Secrets and variables → Actions**.
4. The workflow sets `BASE_PATH=/<repo-name>/` automatically, so the project site works
   at `https://<user>.github.io/<repo>/`. For a user/root site or custom domain at the
   root, set `BASE_PATH` to `/`.

All client asset/link URLs go through `import.meta.env.BASE_URL`, so the project-path
deploy works. Locally, preview a project-path build with
`BASE_PATH=/your-repo/ npm run build`.

## Status & phases

Postgres is canonical; the public pages stay fast/static where possible and go live
only for genuinely dynamic features. The 8-phase plan
(`~/.claude/plans/quirky-jumping-phoenix.md`):

| Phase | What | Status |
|---|---|---|
| 1 | Stabilize the static baseline (rollback point) | ✅ done |
| 2 | Supabase schema + import 13,693 rows; swap the build to read Postgres | ✅ done |
| 3 | Regenerate the SQLite + CSV exports **from** Postgres in `prebuild` | ✅ done |
| — | Rework: **live** Supabase browse + **server-side** `/query` SQL editor; tighten anon grants (replaced the planned static `films-index.json` browse and the sql.js-httpvfs snapshot) | ✅ done |
| 4 | Public `/submit` form → Turnstile-verified Edge Function → moderation via Supabase Studio | ✅ done |
| 5 | Filtering, sorting, shareable URL state, A–Z navigation, clickable rating chips | ✅ done |
| 6 | TMDB enrichment into Postgres (posters + metadata) | ✅ done (~12.4k films enriched) |
| — | Schema refactor: 1:1 `movie_tmdb` table + `redirects` table (drop `movies.is_redirect`) | ✅ done |
| 7 | Public read-only API (PostgREST over `public_movies_api`); see [`docs/api.md`](docs/api.md) | ✅ done |
| 8 | Custom moderator admin SPA (only if Studio proves insufficient) | ⬜ planned |

The live browse/query rework departed from the plan: a GitHub Pages quirk (it gzips
files and serves *compressed* byte ranges) made the in-browser SQLite range-request
DB unusable, so browse and `/query` now query Supabase directly instead.

## TMDB enrichment (Phase 6)

The detail page renders a poster, genre chips, and a TMDB link for any film with a
`movie_tmdb` row. The enrichment **has been run** (~12.4k films matched). To re-run or
refresh it (e.g. with `--include-low`), two steps:

```bash
# 1. Match every film to a TMDB id (needs a free TMDB v3 key/v4 token + `pip install requests`).
#    Resumable — re-run to resume; writes tmdb_matches.csv with poster_path/overview/genre_ids.
export TMDB_API_KEY="..."
python3 scripts/tmdb_match.py --input export/films.json --out tmdb_matches.csv

# 2. Fold the matches into Postgres (movie_tmdb + genres + movie_genres). Service-role key only;
#    no TMDB key needed. Idempotent. Add --include-low to also apply weak matches.
node --env-file=.env scripts/apply_tmdb.mjs
```

After step 2, the next `npm run build` (or a CI redeploy) renders posters/genres. The
`TMDB_API_KEY` stays script-time only — never shipped to the client. (`scripts/apply_tmdb.py`
is the older variant that writes the legacy SQLite/exports for the separate export site.)

## Public API (Phase 7)

The data is also a read-only JSON API via Supabase PostgREST — the same backend the
browse page uses. The curated `public_movies_api` view (one row per real film, with
TMDB fields + a `genres[]` array, safe columns only) is granted `SELECT` to `anon`;
writes are rejected. Full reference, including filtering, sorting, paging, and
full-text search (`search_tsv` `wfts`), is in **[`docs/api.md`](docs/api.md)**. No
signup or per-user key — requests carry the public anon key. Quick taste:

```bash
KEY="sb_publishable_MnMcji0ZPqJZPTn911Sg1A_KCzvBVO3"
BASE="https://vjtavurzjxfjczpvtpdq.supabase.co/rest/v1"
curl "$BASE/public_movies_api?select=title,year,usccb_code,genres&usccb_code=eq.O&year=gte.2000&limit=5" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
