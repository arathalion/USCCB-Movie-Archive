# Public API

The archive's data is available as a read-only JSON API. It speaks the
[PostgREST](https://postgrest.org/) query dialect — no signup, no key.

> **Moved (August 2026).** This API used to run on Supabase. The free-tier
> project kept auto-pausing (taking the API down with it), so it now runs on a
> Cloudflare Worker backed by D1. **The only change callers need is the base
> URL.** The query dialect, resource names, column names, response shapes and
> `content-range` count header are all unchanged, and the old `apikey` /
> `Authorization` headers are still accepted (and ignored), so existing clients
> keep working as-is. See [Differences from PostgREST](#differences-from-postgrest).

> **Read-only.** Writes are rejected. The only way to add data is the moderated
> [`/submit`](../src/pages/submit.astro) form.

## Endpoint

| | |
|---|---|
| Base URL | `https://movie-archive-api.viacrusis14.workers.dev/rest/v1` |
| Auth | none — send nothing, or keep sending the old headers; both work |

```bash
BASE="https://movie-archive-api.viacrusis14.workers.dev/rest/v1"
curl "$BASE/public_movies_api?select=title,year&limit=5"
```

**Building a tool or an agent against this?** There's a machine-readable summary
at [`/llms.txt`](../public/llms.txt) (served at the site root) covering the
schema, operators, rating semantics, and the bulk downloads to use instead of
crawling.

<details>
<summary>Previous (Supabase) endpoint — retired</summary>

```bash
# No longer served; the project was deleted after the migration.
KEY="sb_publishable_MnMcji0ZPqJZPTn911Sg1A_KCzvBVO3"
BASE="https://vjtavurzjxfjczpvtpdq.supabase.co/rest/v1"
curl "$BASE/public_movies_api?select=title,year&limit=5" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
</details>

## The `public_movies_api` resource

One row per real film (13,205 total). This curated view is the recommended
entry point — it exposes only public-facing columns and folds in TMDB
enrichment + genres:

| Column | Type | Notes |
|---|---|---|
| `id` | int | Stable archive id (PK). |
| `slug` | text | URL key — the film page is `/film/{slug}`. |
| `title` | text | |
| `year` | int | Nullable (~3.6% missing). |
| `usccb_code` | text | `A-I`, `A-II`, `A-III`, `A-IV`, `L`, `O` (nullable). See legend below. |
| `mpaa_rating` | text | `G`/`PG`/`PG-13`/`R`/`NC-17`… (nullable, ~42% missing). |
| `synopsis` | text | Short capsule review (~99% of films). |
| `tmdb_id` | int | The Movie Database id, if matched (~12.4k films). |
| `poster_path` | text | TMDB poster path; full URL is `https://image.tmdb.org/t/p/w342{poster_path}`. |
| `tmdb_release_date` | date | From TMDB, if matched. |
| `overview` | text | TMDB synopsis, if matched. |
| `genres` | text[] | Genre names, e.g. `["Drama","Horror"]`; `[]` when not enriched. |

The long-form `full_review` (1,619 films) is **not** in this view — query the
`movies` table directly (below) if you need it.

## Querying

PostgREST turns query-string params into filters. Full reference:
<https://postgrest.org/en/stable/references/api/tables_views.html>.

**Pick columns** with `select` (comma-separated):

```
?select=title,year,usccb_code,genres
```

**Filter** with `column=op.value`:

```
?usccb_code=eq.O&year=gte.2000           # morally offensive, 2000+
?year=gte.1930&year=lte.1939             # the 1930s
?mpaa_rating=in.(R,NC-17)                # multiple values
?genres=cs.{Horror}                      # array contains "Horror"
?title=ilike.*vampire*                   # case-insensitive substring
```

Common ops: `eq` `neq` `gt` `gte` `lt` `lte` `like` `ilike` `in` `is`
(`is.null`), and `cs` (array contains).

**Sort** with `order`, **page** with `limit`/`offset`:

```
?order=year.desc.nullslast&limit=20&offset=40
```

**Total count** — ask for it in a header (responses are capped at 1,000 rows):

```bash
curl -sI "$BASE/public_movies_api?select=id&usccb_code=eq.O" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0"
# → content-range: 0-0/1234
```

### Full-text search

The view has no search column; for ranked full-text search query the **`movies`**
table directly. It carries a Postgres `tsvector` (`search_tsv`, weighted
title > synopsis > full_review) exposed through PostgREST's `wfts` (websearch)
operator:

```bash
curl "$BASE/movies?select=title,year&search_tsv=wfts(english).vampire&order=year.asc&limit=10" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

`wfts` accepts websearch syntax: `"quoted phrase"`, `-exclude`, `or`.

## Other readable resources

All are public, read-only:

- **`movies`** — the canonical table (everything in the view, minus `genres`, plus
  `full_review`, `letter`, `source_file`, and `search_tsv`).
- **`redirects`** — 330 "see other title" alias stubs (`slug`, `title`,
  `target_title`, `target_movie_id` → `movies.id`, resolved for 311).
- **`usccb_ratings`** — rating lookup (`code`, `label`, `description`, `sort_order`).
- **`genres`** / **`movie_genres`** — genre names and the M2M links.
- **`movie_tmdb`** — raw TMDB enrichment (1:1 with `movies` on `movie_id`).

Submissions and moderation tables are **not** exposed to anon.

### Embedding related rows

PostgREST can embed related resources by foreign key in one request:

```bash
curl "$BASE/movies?select=title,year,movie_genres(genres(name))&id=eq.100" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

## Differences from PostgREST

The backend is now a hand-written translator over SQLite, not PostgREST itself.
Everything documented above works; these are the known gaps:

| Behaviour | Status |
|---|---|
| `select`, `eq` `neq` `gt` `gte` `lt` `lte` `in` `is` `ilike` `cs`, `order` (incl. `nullsfirst`/`nullslast`), `limit`, `offset`, `Range`, `Prefer: count=exact` | ✅ identical |
| `search_tsv=wfts(english).…` | ✅ same syntax (quoted phrases, `-exclude`, `or`); ranking is FTS5 bm25 rather than a weighted tsvector, so *result order within equal relevance* can differ |
| **Embedded resources** — `select=…,movie_genres(genres(name))` | ❌ not supported; returns a 400. Use `public_movies_api`, which already includes `genres`, or fetch the related resource separately |
| `like` (case-sensitive) | ⚠️ implemented with SQLite `GLOB`. `*` works as documented; `?` means "any single character" |
| `not.`, `or=`, `and=`, range/JSON operators | ❌ not supported; returns a 400 naming the supported operators |
| Unknown column or resource | ✅ 400/404 with a PostgREST-shaped error body (`message`, `hint`, `details`, `code`) |

## Limits & etiquette

- Responses return at most **1,000 rows**; page with `limit`/`offset` and use the
  `count=exact` header for totals.
- This is a small hobby archive on Cloudflare's free tier — please be gentle
  (cache results, avoid hammering). It's a fixed historical dataset
  (1905–2011), so responses rarely change; they are served with
  `cache-control: max-age=300, s-maxage=86400`.

## USCCB rating legend

`A-I` general patronage · `A-II` adults and adolescents · `A-III` adults ·
`A-IV` adults with reservations · `L` limited adult audience ·
`O` morally offensive.
