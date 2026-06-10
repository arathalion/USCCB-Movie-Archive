// Stable URL slugs. The reviews table has no slug column, so we read the
// authoritative, already-unique slugs from export/films.json (the spec allows
// this) and key them by film id. Build-time only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Anchored to project root (cwd during build) — see note in db.js.
const path = join(process.cwd(), 'export', 'films.json');
const films = JSON.parse(readFileSync(path, 'utf8'));

/** @type {Map<number, string>} */
export const slugById = new Map(films.map((f) => [f.id, f.slug]));
