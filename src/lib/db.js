// Build-time database access. Uses Node's built-in node:sqlite (Node >= 24),
// so there is no native module to compile. Reads the same file that ships to
// the browser (public/movies_web.db) to keep build output and runtime in sync.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// Anchor to the project root (cwd during `astro dev`/`build`); import.meta.url is
// unreliable here because Astro relocates this module into dist/ at build time.
const dbPath = join(process.cwd(), 'public', 'movies_web.db');

let _db;
export function getDb() {
  if (!_db) _db = new DatabaseSync(dbPath, { readOnly: true });
  return _db;
}
