// One-shot escape hatch: dump every table this site needs out of Supabase into
// committed, text-based files under data/. After this runs, Postgres is no longer
// required to build the site — data/ becomes the canonical source.
//
//   node scripts/dump_from_postgres.mjs
//
// NDJSON (one JSON object per line) rather than a SQLite blob or a single giant
// JSON array: it diffs sanely in git, streams, and survives partial reads.

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.SUPABASE_URL) {
  try { process.loadEnvFile(join(process.cwd(), '.env')); } catch {}
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY.');
  process.exit(1);
}

// The submission tables are behind RLS and invisible to the anon key. Use the
// service-role key when it's available so pending submissions get rescued too;
// it never leaves this machine (.env is gitignored).
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false } });
const admin = serviceKey
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;
console.log(admin ? 'Service-role key found — will include RLS-protected tables.\n'
                  : 'No service-role key — RLS-protected tables will be skipped.\n');

// search_tsv is a generated tsvector: derived, enormous (~16 MB of the dump) and
// meaningless outside Postgres. It is rebuilt by whatever indexes the data next.
const DROP_COLUMNS = new Set(['search_tsv']);
const outDir = join(process.cwd(), 'data');
mkdirSync(outDir, { recursive: true });

const PAGE = 1000; // PostgREST caps each response at 1000 rows

// Paginate by a stable unique key so range windows can't skip or duplicate.
async function fetchAll(table, orderBy, client = supabase) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of data) {
      for (const col of DROP_COLUMNS) delete row[col];
      out.push(row);
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// Tables the site actually builds from. `required` ones abort the dump on failure;
// the others are RLS-protected and expected to come back empty for the anon key.
const TABLES = [
  { name: 'movies',                  order: 'id',       required: true },
  { name: 'redirects',               order: 'id',       required: true },
  { name: 'movie_tmdb',              order: 'movie_id', required: true },
  { name: 'genres',                  order: 'id',       required: true },
  { name: 'movie_genres',            order: 'movie_id', required: true },
  { name: 'usccb_ratings',           order: 'code',     required: true },
  { name: 'movie_submissions',       order: 'id',       required: false },
  { name: 'submission_review_events', order: 'id',      required: false },
];

let failed = false;
const summary = [];

for (const { name, order, required } of TABLES) {
  try {
    // RLS-protected tables need the service role; everything else uses anon.
    const rows = await fetchAll(name, order, required ? supabase : (admin ?? supabase));
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    writeFileSync(join(outDir, `${name}.ndjson`), ndjson);
    summary.push(`  ${name.padEnd(24)} ${String(rows.length).padStart(6)} rows`);
    console.log(`✓ ${name}: ${rows.length} rows`);
  } catch (e) {
    const msg = `${name}: ${e.message}`;
    if (required) {
      console.error(`✗ REQUIRED ${msg}`);
      failed = true;
    } else {
      // Expected for RLS-protected tables read with the anon key.
      console.warn(`- skipped ${msg}`);
      summary.push(`  ${name.padEnd(24)}      – not readable (RLS)`);
    }
  }
}

console.log('\n' + summary.join('\n'));
if (failed) {
  console.error('\nOne or more REQUIRED tables failed — dump is incomplete.');
  process.exit(1);
}
console.log('\n✓ Dump complete → data/');
