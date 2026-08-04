// Cloudflare Worker backing the USCCB Movie Archive.
//
// Replaces three Supabase pieces at once:
//   GET  /rest/v1/:resource            → PostgREST-compatible read API (docs/api.md)
//   POST /rest/v1/rpc/run_read_only_sql → the /query page's SQL endpoint
//   POST /submit                        → the moderated submission form
//
// The archive is a fixed 1905–2011 dataset, so everything read-side is heavily
// cacheable; the only write path is /submit, gated on a server-side Turnstile check.

import { buildSelect, isResource, jsonArrayColumns, ApiError, MAX_LIMIT } from './postgrest.js';
import {
  loginPage, queuePage, SESSION_COOKIE, SESSION_TTL_SECONDS,
  makeSession, verifySession, readCookie, timingSafeEqual,
} from './admin.js';
import { allocate, letterFor, openPullRequest } from './publish.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  // apikey/authorization are accepted (and ignored) so callers written against
  // the old Supabase endpoint keep working with only a base-URL change.
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, range, x-client-info',
  'Access-Control-Expose-Headers': 'content-range, content-location',
  'Access-Control-Max-Age': '86400',
};

// Read responses are immutable in practice; let the edge and browsers cache hard.
const READ_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });

// PostgREST-shaped error body, so existing client error handling still matches.
const fail = (status, message, hint, code = null) =>
  json({ message, hint: hint ?? null, details: null, code }, { status });

function parseRange(header) {
  if (!header) return null;
  const m = /^(?:items=)?(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] === '' ? start + MAX_LIMIT - 1 : parseInt(m[2], 10);
  if (end < start) return null;
  return { start, end };
}

// SQLite gives back JSON-array columns as strings; the old API returned real
// arrays (genres: ["Drama","Horror"]), so restore that shape.
function hydrate(rows, resource, columns) {
  const arrayCols = jsonArrayColumns(resource).filter((c) => columns.includes(c));
  if (!arrayCols.length) return rows;
  for (const row of rows) {
    for (const c of arrayCols) {
      if (typeof row[c] === 'string') {
        try { row[c] = JSON.parse(row[c]); } catch { row[c] = []; }
      } else if (row[c] == null) {
        row[c] = [];
      }
    }
  }
  return rows;
}

async function handleRest(request, env, resource, url) {
  if (!isResource(resource)) {
    return fail(404, `unknown resource "${resource}"`, null, '42P01');
  }

  const range = parseRange(request.headers.get('range'));
  const prefer = (request.headers.get('prefer') || '').toLowerCase();
  const wantCount = prefer.includes('count=exact');

  let plan;
  try {
    plan = buildSelect(resource, url.searchParams, range);
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message, e.hint, '42703');
    throw e;
  }

  const stmt = env.DB.prepare(plan.sql).bind(...plan.params);
  const { results } = await stmt.all();
  const rows = hydrate(results ?? [], resource, plan.columns);

  const headers = { 'cache-control': READ_CACHE };

  // content-range mirrors PostgREST: "start-end/total" (or /* when not counted).
  const first = plan.offset;
  const last = rows.length ? plan.offset + rows.length - 1 : plan.offset;
  if (wantCount) {
    const countRow = await env.DB.prepare(plan.countSql).bind(...plan.countParams).first();
    const total = countRow?.n ?? 0;
    headers['content-range'] = `${first}-${rows.length ? last : first}/${total}`;
  } else {
    headers['content-range'] = `${first}-${rows.length ? last : first}/*`;
  }

  // HEAD is used with Range: 0-0 purely to read the count header.
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
    });
  }
  return json(rows, { headers });
}

// ---------------------------------------------------------------------------
// Read-only SQL (the /query page)
//
// D1 has no transaction_read_only and no statement_timeout, so unlike the
// Postgres version — where the database itself refused writes — validation here
// IS the boundary. It is deliberately strict: one statement, must open with
// SELECT/WITH, no statement-terminating semicolons, and a denylist of anything
// that could write, attach, or reach outside the query.
// `pragma\w*` (not `\bpragma\b`) because the table-valued forms — pragma_table_info,
// pragma_database_list — carry an underscore, which is a word character, so a
// trailing \b never matches them and they would slip straight through.
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|replace|attach|detach|pragma\w*|vacuum|reindex|analyze|begin|commit|rollback|savepoint|grant|revoke|trigger|load_extension|readfile|writefile)\b/i;

// Blank out string literals and quoted identifiers before any structural check.
// Without this, a legitimate search like `where synopsis like '%update%'` trips
// the denylist, and a ";" inside review text reads as a second statement.
// Replacement preserves length so nothing else shifts.
function stripLiterals(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:[^"]|"")*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"');
}

function validateReadOnlySql(raw) {
  if (typeof raw !== 'string') throw new ApiError(400, 'query must be a string');
  const sql = raw.trim().replace(/;\s*$/, '');
  if (!sql) throw new ApiError(400, 'Enter a query.');

  const bare = stripLiterals(sql);
  if (bare.includes(';')) throw new ApiError(400, 'Only a single statement is allowed (remove extra ";").');
  if (!/^\s*(select|with)\b/i.test(bare)) throw new ApiError(400, 'Only read-only SELECT / WITH queries are allowed.');
  if (FORBIDDEN.test(bare)) throw new ApiError(400, 'Only read-only SELECT / WITH queries are allowed.');
  return sql;
}

async function handleRpc(request, env, fn) {
  if (fn !== 'run_read_only_sql') {
    return fail(404, `unknown function "${fn}"`, null, '42883');
  }
  let body;
  try { body = await request.json(); } catch { return fail(400, 'invalid JSON body'); }

  let sql;
  try { sql = validateReadOnlySql(body?.query); }
  catch (e) { return fail(e.status ?? 400, e.message, e.hint); }

  try {
    const { results } = await env.DB.prepare(`SELECT * FROM (${sql}) LIMIT ${MAX_LIMIT}`).all();
    return json(results ?? [], { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    // Surface SQLite's message — the page shows it to the user, same as before.
    return fail(400, String(e?.message ?? e).replace(/^D1_ERROR:\s*/, ''));
  }
}

// ---------------------------------------------------------------------------
// Submissions

async function verifyTurnstile(token, ip, secret) {
  if (!secret) return { success: true, skipped: true }; // unset → dev/local
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token ?? '');
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form,
  });
  return res.json();
}

const trim = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

async function handleSubmit(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'invalid JSON body'); }

  const title = trim(body.title, 300);
  if (!title) return fail(400, 'A title is required.');

  const yearRaw = body.year;
  let year = null;
  if (yearRaw !== null && yearRaw !== undefined && yearRaw !== '') {
    year = parseInt(yearRaw, 10);
    if (Number.isNaN(year) || year < 1880 || year > 2100) {
      return fail(400, 'Year must be a four-digit year between 1880 and 2100.');
    }
  }

  const verdict = await verifyTurnstile(
    body.token, request.headers.get('cf-connecting-ip'), env.TURNSTILE_SECRET
  );
  if (!verdict.success) return fail(403, 'Captcha verification failed. Please try again.');

  await env.DB.prepare(
    `INSERT INTO movie_submissions
       (title, year, usccb_code, mpaa_rating, explanation, source_url, submitter_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    title, year,
    trim(body.usccb_code, 10), trim(body.mpaa_rating, 20),
    trim(body.explanation, 5000), trim(body.source_url, 2000),
    trim(body.submitter_name, 120)
  ).run();

  return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Private admin (see admin.js for the auth model)

const ADMIN_STATUSES = new Set(['pending', 'accepted', 'rejected']);

// Same-origin only: no CORS headers here, and every response is no-store. The
// admin surface is deliberately not reachable from the public site's origin.
const adminJson = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });

async function handleAdmin(request, env, path, url) {
  // Fail CLOSED when no password is configured. An unset secret must never mean
  // "let everyone in" — that is precisely how /submit stayed open unnoticed.
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    return new Response(
      'Admin is disabled: ADMIN_PASSWORD is not set.\n' +
      'Set it with:  wrangler secret put ADMIN_PASSWORD --name movie-archive-api\n',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
    );
  }

  // --- login / logout ---
  if (path === '/admin/login' && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const supplied = form?.get('password');
    if (typeof supplied !== 'string' || !timingSafeEqual(supplied, password)) {
      // Blunt the guessing rate a little; Workers bills wall-clock, not CPU, for this.
      await new Promise((r) => setTimeout(r, 700));
      return loginPage('Incorrect password.');
    }
    const session = await makeSession(password);
    return new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/admin`,
        'cache-control': 'no-store',
        'set-cookie': `${SESSION_COOKIE}=${session}; Path=/admin; HttpOnly; Secure; ` +
          `SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
      },
    });
  }

  if (path === '/admin/logout' && request.method === 'POST') {
    return new Response(null, {
      status: 204,
      headers: {
        'cache-control': 'no-store',
        'set-cookie': `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      },
    });
  }

  const authed = await verifySession(readCookie(request, SESSION_COOKIE), password);

  if (path === '/admin') {
    if (request.method !== 'GET') return adminJson({ message: 'method not allowed' }, 405);
    return authed ? queuePage() : loginPage(null);
  }

  // Everything past here is data and must be authenticated.
  if (!authed) return adminJson({ message: 'unauthorized' }, 401);

  if (path === '/admin/submissions' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    const base =
      `SELECT id, created_at, title, year, usccb_code, mpaa_rating, explanation,
              source_url, submitter_name, status, reviewed_at
         FROM movie_submissions`;
    const stmt = status === 'all'
      ? env.DB.prepare(`${base} ORDER BY created_at DESC`)
      : env.DB.prepare(`${base} WHERE status = ? ORDER BY created_at DESC`).bind(status);
    const { results } = await stmt.all();
    return adminJson(results ?? []);
  }

  // Publish: take the moderator's edited fields, allocate id/slug, open a PR.
  const pub = path.match(/^\/admin\/submissions\/(\d+)\/publish$/);
  if (pub && request.method === 'POST') {
    const submissionId = Number(pub[1]);
    const body = await request.json().catch(() => null);

    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return adminJson({ message: 'Title is required.' }, 400);

    let year = null;
    if (body?.year !== null && body?.year !== undefined && body?.year !== '') {
      year = parseInt(body.year, 10);
      if (Number.isNaN(year) || year < 1880 || year > 2100) {
        return adminJson({ message: 'Year must be between 1880 and 2100.' }, 400);
      }
    }

    const usccb = body?.usccb_code ? String(body.usccb_code).trim() : null;
    if (usccb) {
      const ok = await env.DB.prepare('SELECT 1 AS x FROM usccb_ratings WHERE code = ?').bind(usccb).first();
      if (!ok) return adminJson({ message: `Unknown USCCB code "${usccb}".` }, 400);
    }

    const { id, slug } = await allocate(env.DB, title, year);
    const film = {
      id, slug, title, year,
      usccb_code: usccb,
      mpaa_rating: body?.mpaa_rating ? String(body.mpaa_rating).trim() : null,
      synopsis: body?.synopsis ? String(body.synopsis).trim() : null,
      full_review: null,
      letter: letterFor(title),
      source_file: `submission:${submissionId}`,
    };

    let pr;
    try {
      pr = await openPullRequest(env, film, submissionId);
    } catch (e) {
      return adminJson({ message: String(e?.message ?? e) }, 502);
    }

    // Only record the outcome once the PR actually exists, so a failed publish
    // leaves the row in the queue to retry rather than silently disappearing.
    await env.DB.prepare(
      `UPDATE movie_submissions
          SET status = 'accepted', reviewed_at = datetime('now'), reviewer = 'admin'
        WHERE id = ?`
    ).bind(submissionId).run();

    return adminJson({ ok: true, pr: pr.url, slug, id });
  }

  const one = path.match(/^\/admin\/submissions\/(\d+)$/);
  if (one && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const next = body?.status;
    if (!ADMIN_STATUSES.has(next)) {
      return adminJson({ message: `status must be one of ${[...ADMIN_STATUSES].join(', ')}` }, 400);
    }
    const res = await env.DB.prepare(
      `UPDATE movie_submissions
          SET status = ?, reviewed_at = datetime('now'), reviewer = 'admin'
        WHERE id = ?`
    ).bind(next, Number(one[1])).run();
    if (!res.meta?.changes) return adminJson({ message: 'no such submission' }, 404);
    return adminJson({ ok: true });
  }

  return adminJson({ message: `no route for ${path}` }, 404);
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Admin is checked before the CORS preflight branch: it is same-origin only
    // and must never advertise itself as cross-origin callable.
    if (path === '/admin' || path.startsWith('/admin/')) {
      try {
        return await handleAdmin(request, env, path, url);
      } catch (e) {
        console.error('admin', e);
        return new Response('internal error', { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/' || path === '/rest/v1') {
        return json({
          name: 'USCCB Movie Archive API',
          docs: 'https://github.com/arathalion/USCCB-Movie-Archive/blob/main/docs/api.md',
          resources: `${url.origin}/rest/v1/public_movies_api`,
        }, { headers: { 'cache-control': READ_CACHE } });
      }

      const rpc = path.match(/^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/);
      if (rpc) {
        if (request.method !== 'POST') return fail(405, 'method not allowed');
        return await handleRpc(request, env, rpc[1]);
      }

      const rest = path.match(/^\/rest\/v1\/([A-Za-z0-9_]+)$/);
      if (rest) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return fail(405, 'this API is read-only', 'submissions go to POST /submit');
        }
        return await handleRest(request, env, rest[1], url);
      }

      if (path === '/submit') {
        if (request.method !== 'POST') return fail(405, 'method not allowed');
        return await handleSubmit(request, env);
      }

      return fail(404, `no route for ${path}`);
    } catch (e) {
      console.error('unhandled', e);
      return fail(500, 'internal error', String(e?.message ?? e));
    }
  },
};
