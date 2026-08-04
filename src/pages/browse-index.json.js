// Emits /browse-index.json at build time: the whole archive in a compact form
// the browse page filters, sorts and pages entirely in the browser.
//
// Why static rather than an API call per keystroke: the homepage then has no
// backend dependency at all. Filtering 13,205 rows in JS takes single-digit
// milliseconds, so it is also faster than a round-trip. Only full-text search
// (which needs FTS5) touches the Worker.
import { getBrowseIndex } from '../lib/db.js';

export function GET() {
  return new Response(JSON.stringify(getBrowseIndex()), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
