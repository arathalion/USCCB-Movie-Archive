// Build-time data access. Reads the NDJSON dumps in data/ — the canonical source
// since the site moved off Supabase. (Postgres was canonical until the free-tier
// project began pausing unpredictably; scripts/dump_from_postgres.mjs produced
// these files.) Everything here runs at build time only; nothing ships to the client.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the working directory, not import.meta.url: Astro bundles this
// module into dist/.prerender/ before running getStaticPaths, so a module-relative
// path points at the wrong place during the build. Both `astro build` and the
// scripts/ entry points run from the project root.
const DATA = join(process.cwd(), 'data');

// 14 MB of movies.ndjson is parsed once and reused — getStaticPaths, the browse
// index and the SQLite export all pull from the same cache.
const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  let text;
  try {
    text = readFileSync(join(DATA, `${name}.ndjson`), 'utf8');
  } catch (e) {
    throw new Error(
      `Missing data/${name}.ndjson — run "node scripts/dump_from_postgres.mjs" ` +
      `or restore it from git. (${e.code})`
    );
  }
  const rows = text.split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`data/${name}.ndjson: malformed JSON on line ${i + 1}`);
    }
  });
  cache.set(name, rows);
  return rows;
}

export function getMovies() { return load('movies'); }
export function getRedirects() { return load('redirects'); }
export function getUsccbRatings() { return load('usccb_ratings'); }

// Distinct genre names (for the browse-page genre filter), alphabetised.
export function getGenres() {
  return load('genres').map((g) => g.name).sort((a, b) => a.localeCompare(b));
}

// movie_id -> { tmdb fields }, and movie_id -> [genre names]. Built once and
// shared, so the joins below stay linear rather than scanning per film.
function buildLookups() {
  if (cache.has('__lookups')) return cache.get('__lookups');
  const tmdb = new Map(load('movie_tmdb').map((t) => [t.movie_id, t]));
  const genreById = new Map(load('genres').map((g) => [g.id, g.name]));
  const genres = new Map();
  for (const { movie_id, genre_id } of load('movie_genres')) {
    const name = genreById.get(genre_id);
    if (!name) continue;
    const list = genres.get(movie_id);
    if (list) list.push(name);
    else genres.set(movie_id, [name]);
  }
  for (const list of genres.values()) list.sort();
  const out = { tmdb, genres };
  cache.set('__lookups', out);
  return out;
}

// Full detail rows for static page generation (one page per non-redirect film).
// Same shape the Supabase version returned, so film/[slug].astro is unchanged.
export function getFilmsForDetail() {
  const { tmdb, genres } = buildLookups();
  return getMovies().map((film) => {
    const t = tmdb.get(film.id);
    return {
      id: film.id,
      slug: film.slug,
      title: film.title,
      year: film.year,
      usccb_code: film.usccb_code,
      mpaa_rating: film.mpaa_rating,
      synopsis: film.synopsis,
      full_review: film.full_review,
      tmdb_id: t?.tmdb_id ?? null,
      poster_path: t?.poster_path ?? null,
      overview: t?.overview ?? null,
      genres: genres.get(film.id) ?? [],
    };
  });
}

// Compact index shipped to the browser for live browse/filter/sort. Positional
// arrays and genre indices rather than objects with repeated keys: the whole
// 13,205-film index lands around 180 KB gzipped, so the browse page filters
// locally with no network round-trip per keystroke.
//
// Wire format: { g: [genreName…], f: [[slug, title, year, usccb, mpaa, letter, [genreIdx…]]…] }
// Nulls are preserved as null (year and both ratings are frequently absent).
export function getBrowseIndex() {
  const { genres } = buildLookups();
  const g = getGenres();
  const genreIdx = new Map(g.map((name, i) => [name, i]));
  const f = getMovies().map((m) => [
    m.slug,
    m.title,
    m.year ?? null,
    m.usccb_code ?? null,
    m.mpaa_rating ?? null,
    m.letter ?? null,
    (genres.get(m.id) ?? []).map((name) => genreIdx.get(name)).filter((i) => i !== undefined),
  ]);
  return { g, f };
}
