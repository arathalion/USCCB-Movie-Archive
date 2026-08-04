// Publishing an accepted submission: writes one JSON file to data/additions/ on a
// new branch and opens a pull request. Merging it triggers the Pages rebuild that
// generates the film's page.
//
// Why a separate file rather than appending to data/movies.ndjson: that file is
// 14 MB, past GitHub's 1 MB Contents API read limit, so a read-modify-write is not
// possible from here — and base64-ing 14 MB would blow the Worker CPU budget anyway.

const GH = 'https://api.github.com';

// GitHub requires a User-Agent and rejects requests without one.
function ghHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'usccb-movie-archive-worker',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${GH}${path}`, { ...init, headers: ghHeaders(token) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message || `GitHub ${res.status}`;
    throw new Error(`${msg}${body?.errors ? ` (${JSON.stringify(body.errors)})` : ''}`);
  }
  return body;
}

// Mirrors the slug style already in the archive: lowercase, alphanumerics only,
// articles kept (existing slugs are built from the full title, e.g. "theaddiction").
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

// The `letter` bucket is article-aware — "The Bear" files under b, not t.
export function letterFor(title) {
  const t = String(title).toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
  const m = t.match(/[a-z]/);
  return m ? m[0] : 'a';
}

/**
 * Allocate an id and a unique slug, checking against BOTH the movies table and
 * the redirects table — slugs share one URL namespace, so a collision with a
 * redirect stub would shadow an existing page.
 */
export async function allocate(db, title, year) {
  const maxRow = await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM movies').first();
  const id = (maxRow?.m ?? 0) + 1;

  const base = slugify(title) || `film${id}`;
  const candidates = [base, year ? `${base}${year}` : null].filter(Boolean);
  for (let n = 2; n <= 20; n++) candidates.push(`${base}${year ? year : ''}${n}`);

  for (const slug of candidates) {
    const clash = await db.prepare(
      'SELECT 1 AS x FROM movies WHERE slug = ? UNION ALL SELECT 1 FROM redirects WHERE slug = ? LIMIT 1'
    ).bind(slug, slug).first();
    if (!clash) return { id, slug };
  }
  throw new Error(`could not find a free slug for "${title}"`);
}

/**
 * Open a PR adding data/additions/<slug>.json.
 * Returns { url, branch, path }.
 */
export async function openPullRequest(env, film, submissionId) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;                 // "owner/name"
  if (!token || !repo) {
    throw new Error(
      'Publishing is not configured. Set the GITHUB_TOKEN secret and the GITHUB_REPO var on the Worker.'
    );
  }

  const repoInfo = await gh(token, `/repos/${repo}`);
  const baseBranch = repoInfo.default_branch;
  const baseRef = await gh(token, `/repos/${repo}/git/ref/heads/${baseBranch}`);
  const branch = `add-film/${film.slug}`;

  // Reuse the branch if a previous attempt half-completed, rather than 422-ing.
  try {
    await gh(token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
    });
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }

  const path = `data/additions/${film.slug}.json`;
  const content = JSON.stringify(film, null, 2) + '\n';
  // btoa needs latin1; go via UTF-8 bytes so accented titles survive.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)));

  // If the file already exists on the branch we must pass its sha to update it.
  let existingSha;
  try {
    const cur = await gh(token, `/repos/${repo}/contents/${path}?ref=${branch}`);
    existingSha = cur?.sha;
  } catch { /* not there yet — the normal case */ }

  await gh(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add "${film.title}"${film.year ? ` (${film.year})` : ''} from submission #${submissionId}`,
      content: b64,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });

  const body =
    `Adds **${film.title}**${film.year ? ` (${film.year})` : ''} to the archive, ` +
    `from submission #${submissionId} via the admin queue.\n\n` +
    `| field | value |\n|---|---|\n` +
    `| id | \`${film.id}\` |\n| slug | \`${film.slug}\` |\n` +
    `| year | ${film.year ?? '—'} |\n| USCCB | ${film.usccb_code ?? '—'} |\n` +
    `| MPAA | ${film.mpaa_rating ?? '—'} |\n| letter | \`${film.letter}\` |\n\n` +
    `Merging publishes it: the Pages build merges \`data/additions/\` into the archive ` +
    `and generates \`/film/${film.slug}\`.`;

  try {
    const pr = await gh(token, `/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: `Add "${film.title}" to the archive`, head: branch, base: baseBranch, body }),
    });
    return { url: pr.html_url, branch, path };
  } catch (e) {
    // A PR for this branch may already be open from an earlier attempt.
    if (/pull request already exists/i.test(e.message)) {
      const open = await gh(token, `/repos/${repo}/pulls?head=${repo.split('/')[0]}:${branch}&state=open`);
      if (open?.[0]?.html_url) return { url: open[0].html_url, branch, path };
    }
    throw e;
  }
}
