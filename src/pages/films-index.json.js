// Slim search index emitted as a static JSON file at build time. The browse page
// fetches this instead of touching the database at runtime. Compact array rows to
// keep the payload small: [id, slug, title, year, usccb, mpaa]. Redirect stubs are
// excluded and rows are ordered by title (case-insensitive) — see src/lib/db.js.
import { getFilmsIndex } from '../lib/db.js';

export async function GET() {
  const out = await getFilmsIndex();
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json' },
  });
}
