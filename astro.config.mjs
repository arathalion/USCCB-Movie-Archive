import { defineConfig } from 'astro/config';

// GitHub Pages project sites live at https://<user>.github.io/<repo>/.
// The deploy workflow sets BASE_PATH to "/<repo>/"; locally it defaults to "/".
// Every asset URL (including movies_web.db and the sql.js wasm/worker) must
// respect this base or the in-browser SQL range requests will 404.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  output: 'static',
  base,
  // Optional: full site origin, used for canonical URLs / sitemap if added later.
  site: process.env.SITE_URL || undefined,
  build: {
    // Keep filenames stable and predictable; assets in public/ are copied verbatim.
    assets: 'assets',
  },
});
