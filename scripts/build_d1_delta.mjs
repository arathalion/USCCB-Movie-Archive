// Emit SQL for JUST the films in data/additions/ — not the whole archive.
//
//   node scripts/build_d1_delta.mjs   → worker/delta.sql
//
// Adding one film by re-running the full 17 MB seed is wasteful, takes D1 offline
// for the duration of the import, and is prone to D1_RESET_DO on large uploads.
// Additions are a handful of rows, so apply them as a handful of rows.
//
// The full seed still exists (scripts/build_d1_seed.mjs) for a from-scratch rebuild.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dir = join(root, 'data', 'additions');

let names = [];
try {
  names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
} catch {
  /* directory may not exist yet */
}

if (!names.length) {
  writeFileSync(join(root, 'worker', 'delta.sql'), '-- no additions\n');
  console.log('No additions found — wrote an empty delta.');
  process.exit(0);
}

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const COLUMNS = [
  'id', 'slug', 'title', 'year', 'usccb_code', 'mpaa_rating',
  'synopsis', 'full_review', 'letter', 'source_file',
];

const out = [];
const films = names.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));

for (const f of films) {
  if (f.id == null || !f.slug || !f.title) {
    console.error(`✗ data/additions/: a row is missing id/slug/title — ${JSON.stringify(f).slice(0, 120)}`);
    process.exit(1);
  }
  // INSERT OR REPLACE so re-running is idempotent (the workflow may retry).
  out.push(
    `INSERT OR REPLACE INTO movies (${COLUMNS.join(', ')}) VALUES (` +
    COLUMNS.map((c) => lit(f[c] ?? null)).join(', ') + ');'
  );
  // movies_fts is external-content: rows must be mirrored in explicitly. Delete
  // any stale entry first so a re-run doesn't leave duplicate search hits.
  out.push(`DELETE FROM movies_fts WHERE rowid = ${Number(f.id)};`);
  out.push(
    `INSERT INTO movies_fts (rowid, title, synopsis, full_review) VALUES (` +
    `${Number(f.id)}, ${lit(f.title)}, ${lit(f.synopsis ?? null)}, ${lit(f.full_review ?? null)});`
  );
}

writeFileSync(join(root, 'worker', 'delta.sql'), out.join('\n') + '\n');
console.log(`✓ worker/delta.sql — ${films.length} film(s): ${films.map((f) => f.slug).join(', ')}`);
