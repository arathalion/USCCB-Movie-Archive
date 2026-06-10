// Copies the sql.js-httpvfs worker + wasm into public/ so they are served at the
// site root alongside movies_web.db. Run automatically before `dev` and `build`.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const pub = fileURLToPath(new URL('public/', root));
mkdirSync(pub, { recursive: true });

const dist = new URL('node_modules/sql.js-httpvfs/dist/', root);
const files = ['sqlite.worker.js', 'sql-wasm.wasm'];

let copied = 0;
for (const f of files) {
  const from = fileURLToPath(new URL(f, dist));
  const to = fileURLToPath(new URL(f, new URL('public/', root)));
  if (!existsSync(from)) {
    console.error(`[copy-sqljs] missing ${from} — run \`npm install\` first.`);
    process.exit(1);
  }
  copyFileSync(from, to);
  copied++;
}
console.log(`[copy-sqljs] copied ${copied} file(s) into public/`);
