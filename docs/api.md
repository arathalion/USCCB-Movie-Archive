# Public API

The archive's data is available as a read-only JSON API, served by Supabase
[PostgREST](https://postgrest.org/) directly from Postgres. It's the same
backend the website's browse page uses — no signup, no per-user key. Just send
the project's **public anon key** (it's already public; it ships in the site's
JavaScript bundle) with every request.

> **Read-only.** The anon role can only `SELECT`. Writes are rejected. The only
> way to add data is the moderated [`/submit`](../src/pages/submit.astro) form.

## Endpoint & auth

| | |
|---|---|
| Base URL | `https://vjtavurzjxfjczpvtpdq.supabase.co/rest/v1` |
| Anon key | `sb_publishable_MnMcji0ZPqJZPTn911Sg1A_KCzvBVO3` |

Send the key in **both** the `apikey` and `Authorization: Bearer` headers:

```bash
KEY="sb_publishable_MnMcji0ZPqJZPTn911Sg1A_KCzvBVO3"
BASE="https://vjtavurzjxfjczpvtpdq.supabase.co/rest/v1"
curl "$BASE/public_movies_api?select=title,year&limit=5" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

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

## Limits & etiquette

- Responses return at most **1,000 rows**; page with `limit`/`offset` and use the
  `count=exact` header for totals.
- This is a small hobby archive on Supabase's free tier — please be gentle
  (cache results, avoid hammering). It's a fixed historical dataset
  (1905–2011), so responses rarely change.

## USCCB rating legend

`A-I` general patronage · `A-II` adults and adolescents · `A-III` adults ·
`A-IV` adults with reservations · `L` limited adult audience ·
`O` morally offensive.
