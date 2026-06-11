// Phase 6: fold TMDB matches into Supabase Postgres (the canonical store).
//
// Reads tmdb_matches.csv (produced by scripts/tmdb_match.py) and, for every row
// with status `matched` (add --include-low for weak matches too):
//   - updates movies.{tmdb_id, tmdb_title, tmdb_release_date, poster_path,
//     overview, tmdb_enriched_at}
//   - upserts the referenced TMDB genres into `genres` and links them in
//     `movie_genres`.
//
// Uses the SERVICE ROLE key (bypasses RLS) — run locally only.
//   node --env-file=.env scripts/apply_tmdb.mjs
//   node --env-file=.env scripts/apply_tmdb.mjs --matches tmdb_matches.csv --include-low
//
// Idempotent: re-running refreshes movie fields and re-links genres (movie_genres
// upserts are deduped). It does not need the TMDB API key — only the DB key.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env, then:');
  console.error('  node --env-file=.env scripts/apply_tmdb.mjs');
  process.exit(1);
}

// TMDB movie genre ids → names (a fixed, small list, so no API call is needed).
const GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western',
};

// ---- args ----
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const matchesPath = getArg('--matches', 'tmdb_matches.csv');
const includeLow = argv.includes('--include-low');

// ---- minimal RFC-4180 CSV parser (overview can contain commas/quotes/newlines) ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const nil = (v) => (v == null || v === '' ? null : v);

let text;
try {
  text = readFileSync(matchesPath, 'utf8');
} catch {
  console.error(`ERROR: ${matchesPath} not found. Run scripts/tmdb_match.py first.`);
  process.exit(1);
}

const allowed = new Set(['matched', ...(includeLow ? ['low_confidence'] : [])]);
const records = parseCSV(text)
  .filter((r) => allowed.has(r.status) && nil(r.tmdb_id))
  .map((r) => ({
    id: Number(r.id),
    tmdb_id: Number(r.tmdb_id),
    tmdb_title: nil(r.tmdb_title),
    tmdb_release_date: nil(r.tmdb_release_date),
    poster_path: nil(r.poster_path),
    overview: nil(r.overview),
    genre_ids: (r.genre_ids || '')
      .split(';')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  }))
  .filter((r) => Number.isFinite(r.id) && Number.isFinite(r.tmdb_id));

console.log(`Loaded ${records.length} TMDB matches (${includeLow ? 'matched + low_confidence' : 'matched only'}).`);
if (!records.length) process.exit(0);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- 0) drop any match whose id isn't an actual movie row (films.json has one
//         extra id not present in `movies`) so the FK upserts can't fail a batch ----
const validIds = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('movies').select('id').order('id').range(from, from + 999);
  if (error) { console.error('id read failed:', error.message); process.exit(1); }
  for (const r of data) validIds.add(r.id);
  if (data.length < 1000) break;
}
const before = records.length;
const valid = records.filter((r) => validIds.has(r.id));
if (valid.length < before) console.warn(`  ⚠ skipped ${before - valid.length} match(es) with no movies row`);

// ---- 1) upsert the genres that appear, then map tmdb genre id -> genres.id ----
const usedGenreIds = [...new Set(valid.flatMap((r) => r.genre_ids))];
if (usedGenreIds.length) {
  const genreRows = usedGenreIds.map((gid) => ({
    name: GENRE_MAP[gid] || `TMDB ${gid}`,
    tmdb_genre_id: gid,
  }));
  const { error } = await supabase
    .from('genres')
    .upsert(genreRows, { onConflict: 'tmdb_genre_id' });
  if (error) { console.error('genres upsert failed:', error.message); process.exit(1); }
}
const { data: genreRows, error: gErr } = await supabase
  .from('genres')
  .select('id, tmdb_genre_id');
if (gErr) { console.error('genres read failed:', gErr.message); process.exit(1); }
const genreIdByTmdb = new Map(genreRows.map((g) => [g.tmdb_genre_id, g.id]));

// ---- 2) upsert movie_tmdb (1:1 child keyed on movie_id) ----
const now = new Date().toISOString();
const tmdbRows = valid.map((r) => ({
  movie_id: r.id,
  tmdb_id: r.tmdb_id,
  tmdb_title: r.tmdb_title,
  tmdb_release_date: r.tmdb_release_date,
  poster_path: r.poster_path,
  overview: r.overview,
  enriched_at: now,
}));
let enriched = 0;
for (let i = 0; i < tmdbRows.length; i += 500) {
  const batch = tmdbRows.slice(i, i + 500);
  const { error } = await supabase
    .from('movie_tmdb')
    .upsert(batch, { onConflict: 'movie_id' });
  if (error) { console.error('movie_tmdb upsert failed:', error.message); process.exit(1); }
  enriched += batch.length;
  process.stdout.write(`\r  enriched ${enriched}/${tmdbRows.length}`);
}
process.stdout.write('\n');

// ---- 3) link movie_genres (upsert, deduped on the composite PK) ----
const links = valid.flatMap((r) =>
  r.genre_ids
    .map((gid) => genreIdByTmdb.get(gid))
    .filter(Boolean)
    .map((genre_id) => ({ movie_id: r.id, genre_id }))
);
let linked = 0;
for (let i = 0; i < links.length; i += 1000) {
  const batch = links.slice(i, i + 1000);
  const { error } = await supabase
    .from('movie_genres')
    .upsert(batch, { onConflict: 'movie_id,genre_id', ignoreDuplicates: true });
  if (error) { console.error('movie_genres upsert failed:', error.message); process.exit(1); }
  linked += batch.length;
}

console.log(`✓ Done. ${valid.length} movies enriched, ${usedGenreIds.length} genres, ${linked} genre links.`);
