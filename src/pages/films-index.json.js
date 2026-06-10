// Slim search index emitted as a static JSON file at build time. The browse page
// fetches this instead of touching the database at runtime. Compact array rows to
// keep the payload small: [id, slug, title, year, usccb, mpaa]. Redirect stubs
// are excluded.
import { getDb } from '../lib/db.js';
import { slugById } from '../lib/films.js';

export function GET() {
  const rows = getDb()
    .prepare(
      `SELECT id, title, year, cns_rating, mpaa_rating
       FROM reviews
       WHERE is_redirect = 0
       ORDER BY title COLLATE NOCASE`
    )
    .all();

  const out = rows.map((r) => [
    r.id,
    slugById.get(r.id),
    r.title,
    r.year,
    r.cns_rating,
    r.mpaa_rating,
  ]);

  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json' },
  });
}
