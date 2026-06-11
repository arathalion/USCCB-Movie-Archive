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

// Fetch every movie row for the given columns, paginating by id (a stable unique
// key) so the range windows can't skip or duplicate across ties. (Redirect stubs
// live in their own `redirects` table now, so `movies` is all real films.)
async function fetchAllMovies(columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('movies')
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// Distinct genre names (for the browse-page genre filter), alphabetised.
export async function getGenres() {
  const { data, error } = await supabase
    .from('genres')
    .select('name')
    .order('name', { ascending: true });
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return data.map((g) => g.name);
}

// Full detail rows for static page generation (one page per non-redirect film).
// TMDB fields (poster_path, tmdb_id, overview) and embedded genres are null/empty
// until the Phase 6 enrichment (scripts/apply_tmdb.mjs) has run.
export async function getFilmsForDetail() {
  const rows = await fetchAllMovies(
    'id, slug, title, year, usccb_code, mpaa_rating, synopsis, full_review, ' +
      'movie_tmdb(tmdb_id, poster_path, overview), movie_genres(genres(name))'
  );
  // Flatten the 1:1 movie_tmdb child and the embedded genres into plain fields.
  return rows.map(({ movie_tmdb, movie_genres, ...film }) => {
    const tmdb = Array.isArray(movie_tmdb) ? movie_tmdb[0] : movie_tmdb;
    return {
      ...film,
      tmdb_id: tmdb?.tmdb_id ?? null,
      poster_path: tmdb?.poster_path ?? null,
      overview: tmdb?.overview ?? null,
      genres: (movie_genres || []).map((mg) => mg.genres?.name).filter(Boolean).sort(),
    };
  });
}
