// Build-time data access against Supabase Postgres — the canonical source of truth.
// (Replaces the previous node:sqlite reader.) Uses the public anon/publishable key
// and only reads public-read tables, so no secret is needed in the build or CI.
import { createClient } from '@supabase/supabase-js';
import { join } from 'node:path';

// Load .env locally when the vars aren't already in the environment (CI/Actions
// sets them directly). Node >= 20.12 provides process.loadEnvFile.
if (!process.env.SUPABASE_URL) {
  try {
    process.loadEnvFile(join(process.cwd(), '.env'));
  } catch {
    /* no .env file — rely on the ambient environment */
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy .env.example to .env (the values are public).'
  );
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 1000; // PostgREST caps each response at 1000 rows

// Fetch every non-redirect movie row for the given columns, paginating by id (a
// stable unique key) so the range windows can't skip or duplicate across ties.
async function fetchAllMovies(columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('movies')
      .select(columns)
      .eq('is_redirect', false)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// SQLite's COLLATE NOCASE folds only ASCII A–Z; uppercasing is the closest match.
// Tie-break by id for a stable order (mirrors the old rowid tie-break).
const byTitleNocase = (a, b) => {
  const A = (a.title || '').toUpperCase();
  const B = (b.title || '').toUpperCase();
  return A < B ? -1 : A > B ? 1 : a.id - b.id;
};

// Compact rows for the browse index: [id, slug, title, year, usccb, mpaa].
export async function getFilmsIndex() {
  const rows = await fetchAllMovies('id, slug, title, year, usccb_code, mpaa_rating');
  rows.sort(byTitleNocase);
  return rows.map((r) => [r.id, r.slug, r.title, r.year, r.usccb_code, r.mpaa_rating]);
}

// Full detail rows for static page generation (one page per non-redirect film).
// poster_path / tmdb_id are selected ahead of Phase 6 (null until enrichment runs).
export async function getFilmsForDetail() {
  return fetchAllMovies(
    'id, slug, title, year, usccb_code, mpaa_rating, synopsis, full_review, poster_path, tmdb_id'
  );
}
