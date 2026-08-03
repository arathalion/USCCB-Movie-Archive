// Turn data/*.ndjson into a single SQL file that seeds the D1 database.
//
//   node scripts/build_d1_seed.mjs            → worker/seed.sql
//
// Then, from worker/:
//   wrangler d1 execute movie-archive --local  --file=seed.sql
//   wrangler d1 execute movie-archive --remote --file=seed.sql
//
// Rows are batched into multi-row INSERTs: one statement per row would produce
// ~54k statements and D1 import would crawl.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getMovies, getRedirects, getUsccbRatings,
} from '../src/lib/db.js';

const root = process.cwd();
const load = (name) =>
  readFileSync(join(root, 'data', `${name}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// SQLite string literal: double up single quotes. Numbers pass through; null and
// undefined become NULL. Booleans aren't used by this dataset.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Batch by serialised BYTE SIZE, not row count. A few full_review values run to
// tens of KB, so a fixed row count blows the statement-length limit
// (SQLITE_TOOBIG). D1 caps a single statement near 100 KB — far tighter than
// SQLite's own ~1 MB — so stay well under it.
const MAX_STATEMENT_BYTES = 50_000;
const MAX_ROWS_PER_INSERT = 500;

function insertBatches(table, columns, rows, pick) {
  const out = [];
  const header = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n  `;
  let tuples = [];
  let bytes = 0;

  const flush = () => {
    if (!tuples.length) return;
    out.push(header + tuples.join(',\n  ') + ';');
    tuples = [];
    bytes = 0;
  };

  for (const r of rows) {
    const tuple = '(' + pick(r).map(lit).join(',') + ')';
    // A single oversized row still has to go out on its own statement.
    if (tuples.length && (bytes + tuple.length > MAX_STATEMENT_BYTES || tuples.length >= MAX_ROWS_PER_INSERT)) {
      flush();
    }
    tuples.push(tuple);
    bytes += tuple.length + 4;
  }
  flush();
  return out;
}

const parts = [];
parts.push(readFileSync(join(root, 'worker', 'schema.sql'), 'utf8'));
parts.push('\n-- ---------- data ----------\n');

parts.push(...insertBatches(
  'usccb_ratings', ['code', 'label', 'description', 'sort_order'],
  getUsccbRatings(), (r) => [r.code, r.label, r.description, r.sort_order]
));

parts.push(...insertBatches(
  'movies',
  ['id', 'slug', 'title', 'year', 'usccb_code', 'mpaa_rating', 'synopsis', 'full_review', 'letter', 'source_file'],
  getMovies(),
  (r) => [r.id, r.slug, r.title, r.year, r.usccb_code, r.mpaa_rating, r.synopsis, r.full_review, r.letter, r.source_file]
));

parts.push(...insertBatches(
  'genres', ['id', 'name'], load('genres'), (r) => [r.id, r.name]
));

parts.push(...insertBatches(
  'movie_genres', ['movie_id', 'genre_id'], load('movie_genres'),
  (r) => [r.movie_id, r.genre_id]
));

parts.push(...insertBatches(
  'movie_tmdb',
  ['movie_id', 'tmdb_id', 'tmdb_title', 'tmdb_release_date', 'poster_path', 'backdrop_path', 'overview', 'popularity', 'vote_average', 'enriched_at'],
  load('movie_tmdb'),
  (r) => [r.movie_id, r.tmdb_id, r.tmdb_title, r.tmdb_release_date, r.poster_path, r.backdrop_path, r.overview, r.popularity, r.vote_average, r.enriched_at]
));

parts.push(...insertBatches(
  'redirects',
  ['id', 'slug', 'title', 'synopsis', 'letter', 'source_file', 'target_title', 'target_movie_id'],
  getRedirects(),
  (r) => [r.id, r.slug, r.title, r.synopsis, r.letter, r.source_file, r.target_title, r.target_movie_id]
));

// Build the FTS index from the populated content table in one pass.
parts.push("\nINSERT INTO movies_fts(movies_fts) VALUES('rebuild');");

const sql = parts.join('\n') + '\n';
const out = join(root, 'worker', 'seed.sql');
writeFileSync(out, sql);

const mb = (sql.length / 1024 / 1024).toFixed(1);
console.log(`✓ worker/seed.sql — ${mb} MB, ${sql.split('\n').length.toLocaleString()} lines`);
console.log(`  movies ${getMovies().length}, genres ${load('genres').length}, ` +
  `movie_genres ${load('movie_genres').length}, movie_tmdb ${load('movie_tmdb').length}, ` +
  `redirects ${getRedirects().length}`);
