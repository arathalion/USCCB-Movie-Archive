# USCCB / Catholic News Service Movie Reviews — Data Export

A structured export of **13,694** movie reviews originally published by the USCCB
Office for Film & Broadcasting / Catholic News Service. Parsed from the original
`.shtml` archive pages. Coverage spans **1905–2011** (the archive ends in 2011).

## Files

| File | Purpose | Notes |
|------|---------|-------|
| `films.json` | Frontend browse/search | Array of all 13,694 records, light fields only (no full review). Ratings nested under a `ratings` object (`ratings.usccb`, `ratings.mpaa`). ~9.5 MB raw, ~2–3 MB gzipped. |
| `reviews/{id}.json` | Lazy-loaded full reviews | One file per film **that has a full review** (1,619 of them). Self-contained: `id`, `slug`, `title`, `year`, `usccb_rating`, `mpaa_rating`, `full_review`. Fetch by `id` when a detail page opens. |
| `films_full.csv` | Import into another site/DB | Every field including `full_review`, one row per film. Universal format. Flat columns. |
| `films_full.ndjson` | Streaming import | Same as the CSV but newline-delimited JSON (one object per line). Flat fields. |

Pick **one** of `films_full.csv` / `films_full.ndjson` for importing into your
friend's website — they contain identical data, just different formats.

## Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Stable unique key (1–13694). |
| `slug` | string | URL-safe identifier derived from the source filename (e.g. `andy`, `casino`). Unique. |
| `title` | string | Film title. |
| `year` | integer or null | Release year. Null for ~3.6% where the source had none. |
| `usccb_rating` (a.k.a. `cns_rating`) | string or null | USCCB / Catholic News Service moral rating (see legend below). |
| `mpaa_rating` | string or null | MPAA rating (G, PG, PG-13, R, etc.). Null for ~42% — mostly pre-1968 and foreign films. |
| `synopsis` | string or null | Short capsule review. |
| `full_review` | string or null | Long-form review (1,619 films). Paragraphs separated by a blank line. In the CSV/NDJSON and `reviews/` files, not in `films.json`. |
| `letter` | string | First-letter folder of the source (`a`–`z`). |
| `source_file` | string | Original archive path, e.g. `a/andy.shtml`. |
| `is_redirect` | bool/0-1 | True for 322 "see other title" pointer stubs (no rating/synopsis). |
| `has_full_review` | bool | (`films.json` only) Whether a `reviews/{id}.json` file exists. |

**Note on field shape:** ratings are flat columns (`cns_rating`, `mpaa_rating`) in
`films_full.csv` and `films_full.ndjson`; nested as `ratings.usccb` / `ratings.mpaa`
in `films.json`; and flat as `usccb_rating` / `mpaa_rating` in `reviews/{id}.json`.
Same values throughout — `usccb` = `cns_rating` = the USCCB Office for Film &
Broadcasting classification.

## USCCB rating legend

- **A-I** — general patronage
- **A-II** — adults and adolescents
- **A-III** — adults
- **A-IV** — adults, with reservations (older designation; later folded into **L**)
- **L** — limited adult audience
- **O** — morally offensive

## Field coverage

- title: 100%
- year: 96.4%
- usccb_rating: 96.0%
- mpaa_rating: 58.4%
- full_review: 1,619 films (11.8%)
- redirect stubs: 322
- empty placeholder pages: 229

## Import notes for the friend's website

- `id` and `slug` are both stable, unique keys — use either as the primary key.
- Treat empty strings as null on import; the CSV writes empty cells where a field is null.
- `full_review` may contain newlines and curly quotes — handle quoted multi-line CSV
  cells, or use the NDJSON file to sidestep CSV quoting entirely.
- Two source titles still contain a literal replacement character (La Buche, Pokemon 3
  The Movie) where the original accented letter was lost in the source HTML.
- The data is a fixed historical archive (through 2011) — no updates expected.

## TMDB matching (optional)

Two scripts in the parent folder add TMDB ids to everything here:

1. `python3 tmdb_match.py` → produces `tmdb_matches.csv` (needs a free TMDB key).
2. `python3 apply_tmdb.py` → folds `tmdb_id` back into `movies.db`, `films.json`
   (top-level `tmdb_id`), `films_full.csv`/`.ndjson` (new `tmdb_id` column), and
   each `reviews/{id}.json`. Default applies only `status == matched`; add
   `--include-low` to also apply low-confidence matches. Idempotent — safe to
   re-run after improving matches.

After running both, `tmdb_id` is `null` for films with no confident TMDB match
(common for older/foreign/obscure titles that aren't on TMDB).
