// One-time (idempotent) import: public/movies_web.db  ->  Supabase Postgres `movies`.
//
// Reads the shipped SQLite DB directly with node:sqlite (preserves the \n\n
// paragraph breaks in full_review with no CSV foot-guns) and the stable slugs from
// export/films.json, then upserts every row into Postgres. Uses the SERVICE ROLE key
// (bypasses RLS) — run locally only, never in the client bundle.
//
//   node --env-file=.env scripts/import_to_postgres.mjs
//
// Re-runnable: upserts on `id`, so a second run just refreshes rows.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env, then:');
  console.error('  node --env-file=.env scripts/import_to_postgres.mjs');
  process.exit(1);
}

const VALID_USCCB = new Set(['A-I', 'A-II', 'A-III', 'A-IV', 'L', 'O']);
const BATCH = 500;

const root = process.cwd();
const db = new DatabaseSync(join(root, 'public', 'movies_web.db'), { readOnly: true });

// id -> slug from the canonical export (slugs are NOT in the DB).
const films = JSON.parse(readFileSync(join(root, 'export', 'films.json'), 'utf8'));
const slugById = new Map(films.map((f) => [f.id, f.slug]));

const clean = (v) => (v === null || v === undefined || v === '' ? null : v);
const toYear = (v) => {
  const c = clean(v);
  if (c === null) return null; // Number(null) === 0, so guard before coercing
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
};

const rows = db
  .prepare(
    `SELECT id, title, year, cns_rating, mpaa_rating, synopsis, full_review,
            letter, filename, is_redirect
     FROM reviews ORDER BY id`
  )
  .all();

let missingSlug = 0;
let coercedRating = 0;
const records = rows.map((r) => {
  const slug = slugById.get(r.id);
  if (!slug) missingSlug++;
  let usccb = clean(r.cns_rating);
  if (usccb && !VALID_USCCB.has(usccb)) {
    coercedRating++;
    usccb = null; // FK would reject out-of-legend codes; null them defensively
  }
  return {
    id: r.id,
    slug: slug ?? `film-${r.id}`, // fallback keeps the import from failing on a stray id
    title: r.title,
    year: toYear(r.year),
    usccb_code: usccb,
    mpaa_rating: clean(r.mpaa_rating),
    synopsis: clean(r.synopsis),
    full_review: clean(r.full_review),
    letter: clean(r.letter) ? String(r.letter)[0] : null,
    source_file: clean(r.filename),
    is_redirect: r.is_redirect === 1 || r.is_redirect === true,
  };
});

console.log(`Read ${records.length} rows from movies_web.db`);
if (missingSlug) console.warn(`  ⚠ ${missingSlug} rows had no slug in films.json (used film-<id> fallback)`);
if (coercedRating) console.warn(`  ⚠ ${coercedRating} rows had an out-of-legend rating (set to null)`);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let done = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const batch = records.slice(i, i + BATCH);
  const { error } = await supabase.from('movies').upsert(batch, { onConflict: 'id' });
  if (error) {
    console.error(`Batch starting at ${i} failed:`, error.message);
    process.exit(1);
  }
  done += batch.length;
  process.stdout.write(`\r  upserted ${done}/${records.length}`);
}
process.stdout.write('\n');

const { count, error: countErr } = await supabase
  .from('movies')
  .select('*', { count: 'exact', head: true });
if (countErr) console.error('Count check failed:', countErr.message);
else console.log(`✓ Import complete. movies now has ${count} rows.`);
