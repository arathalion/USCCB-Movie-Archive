# Build Spec — USCCB Movie Reviews Archive (GitHub Pages + in-browser SQL)

Hand this file to Claude Code. It describes a self-contained static website for an
archive of **13,694** USCCB / Catholic News Service movie reviews (coverage
**1905–2011**), hosted on **GitHub Pages**, with the **SQLite database as the single
source of truth** and a **power-user SQL query interface that runs entirely in the
browser**. No backend, no server, no database service.

---

## 1. Architecture (read this first)

- **Source of truth:** `movies_web.db` (committed to the repo). The browser queries
  it directly — no API.
- **Browse + detail pages** are statically generated **at build time** by reading the
  database with Node's `better-sqlite3`. This keeps them fast and SEO-friendly.
- **The `/query` page** loads the database in the browser via **sql.js-httpvfs**,
  which uses HTTP **range requests** to fetch only the database pages a query needs —
  so users can run arbitrary SQL without downloading the whole file up front.
- GitHub Pages serves static files over a CDN that supports range requests, so this
  works out of the box.

There are **two** database files in this folder:

| File | Use |
|------|-----|
| `movies_web.db` | **Ship this.** Has 4096-byte pages (ideal range-request chunk size) and a `reviews_fts` full-text index. Used by the `/query` page and the build step. |
| `movies.db` | Original (no FTS, default page size). Fine for build-time reads, but prefer `movies_web.db` everywhere for consistency. |

The JSON/CSV exports in `export/` are **not needed for this website** — they exist
only for importing into the separate (friend's) site. Don't depend on them here.

## 2. Database schema (`movies_web.db`)

Table **`reviews`** (one row per film):

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | 1–13694 |
| `title` | TEXT | |
| `year` | INTEGER | nullable (~3.6% null) |
| `cns_rating` | TEXT | USCCB rating: A-I, A-II, A-III, A-IV, L, O (nullable) |
| `mpaa_rating` | TEXT | G/PG/PG-13/R/NC-17/… (nullable, ~42% null) |
| `synopsis` | TEXT | capsule review (nullable) |
| `full_review` | TEXT | long review, present for 1,619 films (nullable); paragraphs split by blank lines |
| `letter` | TEXT | a–z source folder |
| `filename` | TEXT | original archive path |
| `is_redirect` | INTEGER | 1 = "see other title" stub (322 rows) — **exclude from listings** |
| `tmdb_id` | INTEGER | present only if `apply_tmdb.py` has been run; else column may be absent |

Indexes exist on `title`, `year`, `cns_rating`, `mpaa_rating`.

Full-text table **`reviews_fts`** (FTS5, porter+unicode61) over `title`, `synopsis`,
`full_review`, keyed to `reviews.id` via `rowid`. Query pattern:

```sql
SELECT r.title, r.year, r.cns_rating
FROM reviews_fts f JOIN reviews r ON r.id = f.rowid
WHERE reviews_fts MATCH 'redemption' AND r.is_redirect = 0
ORDER BY rank
LIMIT 100;
```

> The WASM build used for the `/query` page must have **FTS5 enabled**. The standard
> sql.js-httpvfs build includes it; if you swap builds, verify, or fall back to `LIKE`
> for text search (slower over range requests).

USCCB rating legend (surface on the About page and as tooltips): A-I general
patronage · A-II adults and adolescents · A-III adults · A-IV adults with
reservations (treat as L) · L limited adult audience · O morally offensive.

## 3. Stack

- **Astro** with static output (`output: 'static'`).
- **better-sqlite3** as a build-time dev dependency to read `movies_web.db` and
  generate browse/detail pages + a small search index.
- **sql.js-httpvfs** on the `/query` page for in-browser SQL.
- Tailwind optional for styling. No runtime server code anywhere.

## 4. Pages

1. **Home / browse** (`/`)
   - Search box over title (ignore case and the ", The" suffix — also index a
     "The X" form), plus filters for USCCB rating, MPAA rating, and decade/year.
   - Build a slim search index at build time (e.g. MiniSearch over id, title, year,
     ratings) so this page doesn't need the DB at runtime.
   - Exclude `is_redirect = 1`. Windowed/paginated rendering (13,694 rows).

2. **Film detail** (`/film/{slug}`)
   - Generated at build time from the DB. Title, year, USCCB + MPAA ratings,
     synopsis, and the `full_review` paragraphs when present.
   - If `tmdb_id` is set: poster + "View on TMDB" link (see §6).
   - `slug` comes from the `export/films.json` slug field, or derive one and keep it
     stable. Use the same slug everywhere.

3. **Power-user query** (`/query`) — the centerpiece. See §5.

4. **About** (`/about`)
   - Source (USCCB Office for Film & Broadcasting / Catholic News Service), the
     **1905–2011** scope (state plainly it's a historical archive), rating legend,
     and a short "how to use the query page" with example queries.

## 5. Power-user query interface (`/query`)

Goal: let a user type SQL and run it against `movies_web.db` in their browser.

**Setup**
- Use `sql.js-httpvfs`. Point it at `/movies_web.db` with a single-file config and
  `requestChunkSize: 4096` (matches the DB page size). Example:
  ```js
  import { createDbWorker } from "sql.js-httpvfs";
  const worker = await createDbWorker(
    [{ from: "inline", config: {
        serverMode: "full", url: "/movies_web.db", requestChunkSize: 4096 } }],
    "/sqlite.worker.js", "/sql-wasm.wasm");
  const rows = await worker.db.query(sql);
  ```
  (Copy `sqlite.worker.js` and `sql-wasm.wasm` from the package into `public/`.)

**UI**
- A SQL `<textarea>` prefilled with a friendly default query.
- "Run" button → render results as a sortable HTML table with a row count and the
  query time. Show DB errors inline.
- "Download results" as CSV and JSON.
- A collapsible **schema reference** panel: the `reviews` columns, the rating legend,
  and the `reviews_fts` MATCH example.
- A list of **clickable example queries** that populate the textarea, e.g.:
  - `SELECT cns_rating, COUNT(*) FROM reviews WHERE is_redirect=0 GROUP BY cns_rating ORDER BY 2 DESC;`
  - `SELECT title, year FROM reviews WHERE cns_rating='O' AND year BETWEEN 2000 AND 2010 ORDER BY year;`
  - `SELECT mpaa_rating, COUNT(*) FROM reviews WHERE mpaa_rating IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;`
  - Full-text: `SELECT r.title,r.year FROM reviews_fts f JOIN reviews r ON r.id=f.rowid WHERE reviews_fts MATCH 'vampire' AND r.is_redirect=0 ORDER BY r.year;`

**Guardrails (important)**
- Treat input as **read-only**: reject statements other than a single `SELECT`/`WITH`
  (block `PRAGMA`, `ATTACH`, `INSERT/UPDATE/DELETE`, multiple statements). It's a local
  copy so nothing persists, but this keeps the UX predictable.
- If the query has no `LIMIT`, append one (e.g. `LIMIT 1000`) and tell the user.
- Cap rendered rows (~1,000) regardless; offer the CSV download for the full set.
- **Escape HTML when rendering every cell** — the data contains user-facing text;
  never inject it as HTML (prevents XSS from review content).
- Run the query in the worker; disable the Run button while in flight.

## 6. TMDB enrichment (optional)

If `tmdb_id` is populated (after running `apply_tmdb.py`): at **build time** fetch
`https://api.themoviedb.org/3/movie/{tmdb_id}?api_key=KEY`, cache `poster_path` to a
JSON, and render `https://image.tmdb.org/t/p/w342{poster_path}` on detail pages, with
an outbound link to `https://www.themoviedb.org/movie/{tmdb_id}`. **Never put the API
key in client code** — it's used only during the build.

## 7. Hosting on GitHub Pages

1. Put everything in a repo. Commit `movies_web.db` **directly** (it's ~23 MB, well
   under GitHub's 100 MB per-file limit). **Do NOT use Git LFS for it** — GitHub Pages
   does not serve LFS files over its CDN, and range requests would break.
2. Ensure the DB and the sql.js worker/wasm files end up in the published output
   (e.g. in Astro's `public/` so they're served at the site root).
3. Add an empty `.nojekyll` file to the output so Jekyll doesn't touch asset folders.
4. Deploy with the official Astro GitHub Actions workflow
   (`withastro/action`) → it builds and publishes to Pages on every push to `main`.
   In repo Settings → Pages, set Source = GitHub Actions.
5. Site goes live at `https://<user>.github.io/<repo>/`. If you use a project path
   (not a user/root site), set Astro's `base` to `/<repo>/` and make all asset URLs
   (including the DB and wasm) respect that base.
6. Custom domain later: Settings → Pages → Custom domain.

GitHub Pages serves gzip and supports HTTP range requests, which is what makes the
in-browser SQL fast.

## 8. Performance notes

- Range requests mean the `/query` page only downloads the DB pages a query touches
  (plus the FTS index pages for text search) — not the whole 23 MB. Keep `LIMIT`s
  reasonable. Queries that scan the whole table (e.g. `LIKE '%x%'`) will pull many
  pages; prefer `reviews_fts MATCH` for text.
- Browse/detail pages are static HTML — instant, no DB at runtime.
- Lazy-render large result tables.

## 9. Acceptance checklist

- [ ] Deploys to GitHub Pages via Actions; loads at the Pages URL.
- [ ] Browse page lists films, excludes `is_redirect`, filters by USCCB + MPAA + year.
- [ ] Title search ignores the ", The" suffix.
- [ ] Detail pages render synopsis + full review; null year/MPAA render gracefully.
- [ ] `/query` runs arbitrary SELECTs against `movies_web.db` via range requests,
      shows results + row count, and exports CSV/JSON.
- [ ] `/query` supports FTS (`reviews_fts MATCH`) and blocks non-SELECT input.
- [ ] Cells are HTML-escaped; no XSS from review text.
- [ ] `movies_web.db` is committed normally (not LFS) and served at the site root.
- [ ] About page states 1905–2011 scope, rating legend, and query examples.
