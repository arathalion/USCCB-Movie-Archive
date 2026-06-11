# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **Astro site deployed to GitHub Pages** for an archive of **13,694 USCCB / Catholic News Service movie reviews** (coverage **1905–2011**). `WEBSITE_BUILD_SPEC.md` is the original spec; `README.md` documents the as-built site. **Supabase Postgres is the single source of truth** — static pages and the SQLite/CSV exports all derive from it.

The site began as a fully static SQLite-in-browser build and is migrating to Supabase over an 8-phase plan (`~/.claude/plans/quirky-jumping-phoenix.md`). **Phases 1–5, plus a live-browse/`/query` rework, are done (all on `main`); phases 6–8 are planned.** See the phase table in `README.md`. Work the migration **in auto mode but pause between phases** — implement one, report, wait for the user before the next.

Rendering is hybrid: detail pages are **static** (built from Postgres); browse, `/query`, and (later) submissions run **live** against Supabase from the browser.

## Repository layout

- `src/pages/` — `index.astro` (**live** Supabase browse: `textSearch` + USCCB/MPAA/year filters + A–Z letter bar on `movies.letter` + sort + clickable rating chips, with shareable `?q=&usccb=&letter=…` URL state via `replaceState`), `film/[slug].astro` (one **static** page per non-redirect film, built from Postgres), `query.astro` (server-side SQL editor via the `run_read_only_sql()` RPC), `submit.astro` (public submission form → Turnstile + `submit-movie` Edge Function), `about.astro`.
- `src/lib/` — `db.js` (build-time `supabase-js` reader; exports `getFilmsForDetail()`, paginates past PostgREST's 1000-row cap with `.range()`; anon key, read-only), `ratings.js` (USCCB legend).
- `supabase/functions/submit-movie/` — Edge Function (`verify_jwt=false`): verifies a Cloudflare Turnstile token server-side, validates input, inserts the submission via the **service role**. The only write path to `movie_submissions`. Needs the `TURNSTILE_SECRET` function secret (falls back to Cloudflare's always-pass test secret if unset).
- `supabase/migrations/` — schema, indexes, RLS policies, `run_read_only_sql()` RPC (190001), anon-grant hardening (190002/190003), submissions-via-function (200001: revokes direct anon INSERT), `movies.letter` index (210001). SECURITY DEFINER helpers (`is_moderator`, submission-status trigger) live in a non-exposed `private` schema.
- `scripts/import_to_postgres.mjs` — one-time data load into Postgres (**service-role key**, bypasses RLS).
- `scripts/export_sqlite.mjs` — regenerates `public/movies_web.db` (legacy `reviews` schema + FTS5) and `export/films_full.csv` **from** Postgres. Runs on `prebuild`; outputs are **git-ignored build artifacts**, shipped under `dist/downloads/`, no longer read at runtime.
- `scripts/tmdb_match.py` / `apply_tmdb.py` — optional TMDB enrichment pipeline (Phase 6; not yet wired into Postgres).
- `export/films.json` — original exports for a *separate* site; not consumed by this build.
- `data/movies.db` — original pre-FTS SQLite, not shipped.
- `source-archive/a/`…`z/` — raw `.shtml` provenance (167 MB). **Git-ignored**, not used by the site or build.
- `.github/workflows/deploy.yml` — GitHub Pages deploy; Node 26, sets `BASE_PATH=/<repo>/`, injects the public Supabase env from repo secrets.

## Supabase project

Project ref `vjtavurzjxfjczpvtpdq` ("Movie-Archive", Postgres 17, us-west-2). The URL + publishable anon key are in committed `.env.example` (public, read-only). The **service-role key** lives only in gitignored `.env` and is used solely by `import_to_postgres.mjs`. Leave the Supabase-managed `public.rls_auto_enable()` (auto-RLS setting) alone.

## Database schema (Postgres)

Table `movies` (one row per film, ids 1–13694):

`id` (PK), `slug` (UNIQUE, stable URL key), `title`, `year` (smallint, ~3.6% null), `usccb_code` (FK → `usccb_ratings.code`: A-I/A-II/A-III/A-IV/L/O, nullable; was `cns_rating`), `mpaa_rating` (~42% null), `synopsis` (capsule), `full_review` (long-form, 1,619 films, `\n\n` paragraph breaks preserved), `letter` (a–z source folder), `source_file` (original archive path; was `filename`), `is_redirect` (boolean, 322 true — **always exclude from listings**). TMDB columns (`tmdb_id`, `tmdb_title`, `poster_path`, `overview`, …) and future date fields exist but are **null until Phase 6**.

Full-text search is a generated `tsvector` column `search_tsv` (title `A` / synopsis `B` / full_review `C`, `english` config) with a GIN index. Query patterns:

```sql
-- server-side / SQL editor
select title, year from movies
where search_tsv @@ websearch_to_tsquery('english', 'vampire') and not is_redirect
order by year;
```

```js
// client-side (supabase-js), as in index.astro
supabase.from('movies').select('slug,title,year,usccb_code,mpaa_rating', { count: 'exact' })
  .eq('is_redirect', false)
  .textSearch('search_tsv', text, { type: 'websearch', config: 'english' });
```

Other tables: `usccb_ratings` (code, label, description, sort_order), `genres`, `movie_genres`, and the submission/moderation tables `moderators`, `movie_submissions`, `submission_review_events` (for phases 4/8). USCCB legend: A-I general patronage · A-II adults and adolescents · A-III adults · A-IV adults with reservations (treat as L) · L limited adult audience · O morally offensive.

The derived `public/movies_web.db` keeps the **legacy** SQLite shape (`reviews` table, `cns_rating`, `filename`, `reviews_fts`) for download compatibility — don't confuse it with the Postgres schema above.

## Configuration

Copy `.env.example` to `.env`. `SUPABASE_URL`/`SUPABASE_ANON_KEY` are used by the build (`db.js`); `PUBLIC_SUPABASE_URL`/`PUBLIC_SUPABASE_ANON_KEY` are inlined into the client bundle (browse + `/query`); both pairs are the public anon values. `SUPABASE_SERVICE_ROLE_KEY` is **secret** (import script only). In CI, the public values come from repo secrets `SUPABASE_URL`/`SUPABASE_ANON_KEY`.

## Commands

```bash
npm install        # approve esbuild/sharp install scripts if prompted
npm run dev        # dev server
npm run build      # prebuild regenerates SQLite/CSV from Postgres, then static site → dist/
npm run export:db  # regenerate the SQLite/CSV exports only
npm run preview    # serve dist/ locally
BASE_PATH=/repo/ npm run build   # simulate a project-path GitHub Pages build
```

Quick data inspection (against Postgres, via the MCP `execute_sql` tool or psql):

```sql
select count(*) from movies where not is_redirect;  -- 13372
```

## Invariants to preserve

- **Exclude `is_redirect = true`** from every listing/index (the 322 "see other title" stubs).
- **Postgres is canonical.** `public/movies_web.db` and `export/films_full.csv` are regenerated from it on `prebuild` and are git-ignored — never hand-edit them, and don't reintroduce them as committed source.
- **Anon auto-grants:** the project grants `anon` **and `authenticated`** ALL privileges on every new `public` table (a side effect of the auto-RLS setting). RLS gates rows, but for any new table add an explicit `revoke all … from anon`/`authenticated` + a narrow `grant` in the same migration. Verify with `information_schema.role_table_grants where grantee in ('anon','authenticated')`.
- **Submissions write path:** `movie_submissions` is written **only** by the `submit-movie` Edge Function (service role). Direct anon INSERT is revoked; don't re-add it. Keep the function as the captcha gate — a client-only check is bypassable since the publishable key ships to the browser.
- All client asset/link URLs go through `import.meta.env.BASE_URL` so the project-path deploy works. Don't hardcode leading-slash paths.
- `/query` is read-only by design, enforced **server-side** by `run_read_only_sql()` (SECURITY INVOKER → anon RLS/grants apply, `transaction_read_only`, 5s `statement_timeout`, single `SELECT`/`WITH`, 1000-row cap, `search_path` pinned). The client guard in `query.astro` is cosmetic; keep both, and keep **every rendered cell HTML-escaped** (review text is untrusted → XSS).
- Build loaders must **paginate** past PostgREST's 1000-row cap (`db.js` loops `.range()`).
- Service-role key and `TMDB_API_KEY` are server/build-time only — never ship them to the client.

This is a fixed historical archive (ends 2011); the only expected new data is moderated public submissions (Phase 4+).
