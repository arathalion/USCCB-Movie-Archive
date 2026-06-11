// Phase 3 — regenerate the downloadable SQLite + CSV FROM Postgres (the canonical
// source). Postgres is now the source of truth; this makes public/movies_web.db a
// derived artifact so the in-browser /query page and the downloads stay in sync.
//
//   node --env-file=.env scripts/export_sqlite.mjs
//
// Produces, with the original legacy schema (table `reviews`, columns cns_rating /
// filename, FTS5 `reviews_fts`, page_size 4096 to match sql.js-httpvfs chunking):
//   public/movies_web.db                       (served for /query)
//   public/downloads/usccb_movie_archive.sqlite (download)
//   export/films_full.csv                       (flat export)
//   public/downloads/usccb_movie_archive.csv    (download)

import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, rmSync, renameSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.SUPABASE_URL) {
  try { process.loadEnvFile(join(process.cwd(), '.env')); } catch {}
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set them in .env).');
  process.exit(1);
}

const root = process.cwd();
const supabase = createClient(url, key, { auth: { persistSession: false } });

// The legacy `reviews` table held ALL rows (real films + redirect stubs) with an
// is_redirect flag. Postgres now keeps those apart (movies + redirects tables), so
// rebuild the combined set here: real films (is_redirect=0) + the stubs
// (is_redirect=1), ordered by id. Keeps the public download byte-compatible.
const PAGE = 1000;
async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(cols).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error(`Supabase read failed (${table}):`, error.message); process.exit(1); }
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const films = (await fetchAll('movies',
  'id, slug, title, year, usccb_code, mpaa_rating, synopsis, full_review, letter, source_file'
)).map((r) => ({ ...r, is_redirect: 0 }));

const redirects = (await fetchAll('redirects',
  'id, slug, title, synopsis, letter, source_file'
)).map((r) => ({
  id: r.id, slug: r.slug, title: r.title, year: null, usccb_code: null,
  mpaa_rating: null, synopsis: r.synopsis, full_review: null,
  letter: r.letter, source_file: r.source_file, is_redirect: 1,
}));

const rows = [...films, ...redirects].sort((a, b) => a.id - b.id);
console.log(`Read ${films.length} films + ${redirects.length} redirects = ${rows.length} rows from Postgres`);

// ---------- Build the SQLite file ----------
const dbPath = join(root, 'public', 'movies_web.db');
const tmpPath = dbPath + '.tmp';
rmSync(tmpPath, { force: true });

const db = new DatabaseSync(tmpPath);
db.exec('PRAGMA page_size=4096;');
db.exec('PRAGMA journal_mode=DELETE;');
db.exec(`CREATE TABLE reviews(
  id INTEGER PRIMARY KEY,
  title TEXT,
  year INTEGER,
  cns_rating TEXT,
  mpaa_rating TEXT,
  synopsis TEXT,
  full_review TEXT,
  letter TEXT,
  filename TEXT UNIQUE,
  is_redirect INTEGER DEFAULT 0
);`);
db.exec('CREATE INDEX idx_title ON reviews(title);');
db.exec('CREATE INDEX idx_year  ON reviews(year);');
db.exec('CREATE INDEX idx_cns   ON reviews(cns_rating);');
db.exec('CREATE INDEX idx_mpaa  ON reviews(mpaa_rating);');
db.exec(`CREATE VIRTUAL TABLE reviews_fts USING fts5(
    title, synopsis, full_review,
    content='reviews', content_rowid='id', tokenize='porter unicode61');`);

const ins = db.prepare(`INSERT INTO reviews
  (id, title, year, cns_rating, mpaa_rating, synopsis, full_review, letter, filename, is_redirect)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
db.exec('BEGIN');
for (const r of rows) {
  ins.run(
    r.id, r.title, r.year, r.usccb_code, r.mpaa_rating, r.synopsis,
    r.full_review, r.letter, r.source_file, r.is_redirect ? 1 : 0
  );
}
db.exec('COMMIT');
db.exec("INSERT INTO reviews_fts(reviews_fts) VALUES('rebuild');");
db.exec('VACUUM;');

const total = db.prepare('SELECT count(*) c FROM reviews').get().c;
const fts = db.prepare("SELECT count(*) c FROM reviews_fts WHERE reviews_fts MATCH 'vampire'").get().c;
db.close();
console.log(`SQLite built: ${total} rows, FTS 'vampire' -> ${fts} hits`);

renameSync(tmpPath, dbPath);

const downloads = join(root, 'public', 'downloads');
mkdirSync(downloads, { recursive: true });
copyFileSync(dbPath, join(downloads, 'usccb_movie_archive.sqlite'));

// ---------- CSV export (matches export/films_full.csv header) ----------
const header = ['id','slug','title','year','cns_rating','mpaa_rating','synopsis','full_review','letter','source_file','is_redirect'];
const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const lines = [header.join(',')];
for (const r of rows) {
  lines.push([
    r.id, r.slug, r.title, r.year, r.usccb_code, r.mpaa_rating,
    r.synopsis, r.full_review, r.letter, r.source_file, r.is_redirect ? 1 : 0,
  ].map(esc).join(','));
}
const csv = lines.join('\n') + '\n';
writeFileSync(join(root, 'export', 'films_full.csv'), csv);
writeFileSync(join(downloads, 'usccb_movie_archive.csv'), csv);

console.log('✓ Wrote public/movies_web.db, public/downloads/*, export/films_full.csv');
