// Private moderation UI, served BY the Worker (not the static site).
//
// The site is on GitHub Pages, where anything published is world-readable — a
// static admin page could hide the data but never the page. Serving it here puts
// the HTML itself behind the same auth check as the data.
//
// Auth is a single password (Worker secret ADMIN_PASSWORD) exchanged for a signed,
// HttpOnly session cookie. That is proportionate for a one-moderator hobby archive,
// but be clear about what it is NOT: no MFA, no per-user accounts, no revocation
// beyond rotating the secret. If this ever needs more, the upgrade path is
// Cloudflare Access in front of a custom domain.

const SESSION_COOKIE = 'archive_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h

const enc = new TextEncoder();

// Constant-time comparison. A plain === leaks how many leading characters matched
// via timing, which is exactly the signal a password guesser wants.
function timingSafeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare lengths without early-exit by folding into the same accumulator.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeSession(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

async function verifySession(value, secret) {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;   // expired
  return timingSafeEqual(sig, await hmac(secret, exp));
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The admin UI must never be cached or framed.
      'cache-control': 'no-store, must-revalidate',
      'x-robots-tag': 'noindex, nofollow',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });

const PAGE_CSS = `
  :root { color-scheme: light dark; --ink:#111; --muted:#666; --line:#ddd; --bg:#fff; --accent:#7a1f1f; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8e6e3; --muted:#9b9b9b; --line:#333; --bg:#16161a; --accent:#e0a3a3; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--ink);
         font:16px/1.5 ui-serif, Georgia, "Times New Roman", serif; }
  .wrap { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  .sub { color:var(--muted); font-size:.85rem; margin:0 0 1.5rem; }
  form.login { max-width:22rem; }
  label { display:block; font-size:.85rem; font-weight:600; margin-bottom:.3rem; }
  input[type=password] { width:100%; padding:.5rem; border:1px solid var(--line);
    border-radius:4px; background:var(--bg); color:var(--ink); font:inherit; }
  button { font:inherit; padding:.45rem .9rem; border:1px solid var(--line);
    border-radius:4px; background:var(--ink); color:var(--bg); cursor:pointer; }
  button.ghost { background:transparent; color:var(--ink); }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:#b3261e; margin:.75rem 0 0; font-size:.9rem; }
  .card { border:1px solid var(--line); border-radius:6px; padding:1rem; margin-bottom:1rem; }
  .card h2 { font-size:1.1rem; margin:0 0 .25rem; }
  .meta { color:var(--muted); font-size:.85rem; margin:0 0 .6rem; }
  .chip { display:inline-block; border:1px solid var(--line); border-radius:99px;
          padding:.05rem .5rem; font-size:.75rem; margin-right:.3rem; }
  .expl { white-space:pre-wrap; margin:.5rem 0; }
  .actions { display:flex; gap:.5rem; margin-top:.75rem; }
  .toolbar { display:flex; gap:.75rem; align-items:center; margin-bottom:1rem; }
  select { font:inherit; padding:.35rem; background:var(--bg); color:var(--ink);
           border:1px solid var(--line); border-radius:4px; }
  .empty { color:var(--muted); font-style:italic; }
  a { color:var(--accent); }
  .editor { border-top:1px solid var(--line); margin-top:.75rem; padding-top:.75rem; }
  .f { display:block; margin-bottom:.6rem; }
  .f span { display:block; font-size:.8rem; font-weight:600; margin-bottom:.2rem; }
  .f input, .f textarea { width:100%; padding:.4rem; border:1px solid var(--line);
    border-radius:4px; background:var(--bg); color:var(--ink); font:inherit; }
  .row { display:flex; gap:.6rem; }
  .row .f { flex:1; }
  .pubmsg { font-size:.85rem; margin:.6rem 0 0; }
  .pubmsg.ok { color:#1a7f37; }
  .pubmsg.err { color:#b3261e; }
`;

export function loginPage(error) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in · Archive admin</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>Archive admin</h1>
<p class="sub">Moderation queue for the USCCB Movie Reviews Archive.</p>
<form class="login" method="POST" action="/admin/login">
  <label for="pw">Password</label>
  <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
  <p style="margin:.75rem 0 0"><button type="submit">Sign in</button></p>
  ${error ? `<p class="err">${error}</p>` : ''}
</form>
</div></body></html>`, error ? 401 : 200);
}

export function queuePage() {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Submissions · Archive admin</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>Submissions</h1>
<p class="sub">Accepting here only marks the row reviewed &mdash; it does <strong>not</strong> put the
film on the site. <code>data/movies.ndjson</code> is canonical; see docs/moderation.md.</p>
<div class="toolbar">
  <label for="status" style="margin:0">Show</label>
  <select id="status">
    <option value="pending" selected>Pending</option>
    <option value="accepted">Accepted</option>
    <option value="rejected">Rejected</option>
    <option value="all">All</option>
  </select>
  <span id="count" class="sub" style="margin:0"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="logout">Sign out</button>
</div>
<div id="list"></div>
</div>
<script>
// Submission text is untrusted (public form) -> escape everything rendered.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

// esc() stops attribute injection but NOT a "javascript:" href — and source_url is
// attacker-controlled (the form's type="url" is client-side only, the API stores any
// string). Anything that isn't plainly http/https is shown as inert text instead.
function safeHref(u) {
  try {
    const p = new URL(String(u));
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : null;
  } catch { return null; }
}

function field(id, label, value, opts) {
  return '<label class="f"><span>' + label + '</span>' +
    (opts && opts.textarea
      ? '<textarea id="' + id + '" rows="5">' + esc(value) + '</textarea>'
      : '<input id="' + id + '" value="' + esc(value) + '"' +
        (opts && opts.type ? ' type="' + opts.type + '"' : '') + '>') +
    '</label>';
}

function card(s) {
  const bits = [s.year, s.usccb_code, s.mpaa_rating].filter(Boolean)
    .map((b) => '<span class="chip">' + esc(b) + '</span>').join('');
  let src = '';
  if (s.source_url) {
    const href = safeHref(s.source_url);
    src = '<p class="meta">Source: ' + (href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(href) + '</a>'
      : '<span title="not a http(s) URL — shown as text">' + esc(s.source_url) + '</span>') + '</p>';
  }
  const who = s.submitter_name ? ' &middot; ' + esc(s.submitter_name) : '';

  // Pending rows get the editable publish form; reviewed rows are read-only.
  const editor = s.status === 'pending'
    ? '<div class="editor" id="ed-' + s.id + '" hidden>' +
        '<p class="meta">Check these before publishing &mdash; they go into the archive verbatim. ' +
        'The synopsis is prefilled from the submitter&rsquo;s notes, which are <em>not</em> archive prose.</p>' +
        field('t-' + s.id, 'Title', s.title || '') +
        '<div class="row">' +
          field('y-' + s.id, 'Year', s.year == null ? '' : s.year, { type: 'number' }) +
          field('u-' + s.id, 'USCCB', s.usccb_code || '') +
          field('m-' + s.id, 'MPAA', s.mpaa_rating || '') +
        '</div>' +
        field('s-' + s.id, 'Synopsis', s.explanation || '', { textarea: true }) +
        '<div class="actions">' +
          '<button data-pub="' + s.id + '">Publish &rarr; open PR</button>' +
          '<button class="ghost" data-cancel="' + s.id + '">Cancel</button>' +
        '</div>' +
        '<p class="pubmsg" id="msg-' + s.id + '"></p>' +
      '</div>'
    : '';

  const acts = s.status === 'pending'
    ? '<div class="actions" id="act-' + s.id + '">' +
      '<button data-edit="' + s.id + '">Accept &amp; publish&hellip;</button>' +
      '<button class="ghost" data-id="' + s.id + '" data-to="rejected">Reject</button></div>'
    : '';

  return '<div class="card"><h2>' + esc(s.title) + '</h2>' +
    '<p class="meta">' + bits + ' #' + s.id + ' &middot; ' + esc(s.created_at) + who +
    ' &middot; <strong>' + esc(s.status) + '</strong></p>' +
    (s.explanation ? '<p class="expl">' + esc(s.explanation) + '</p>' : '') +
    src + acts + editor + '</div>';
}

async function load() {
  listEl.innerHTML = '<p class="empty">Loading&hellip;</p>';
  const r = await fetch('/admin/submissions?status=' + encodeURIComponent(statusEl.value),
                        { credentials: 'same-origin' });
  if (r.status === 401) { location.reload(); return; }
  if (!r.ok) { listEl.innerHTML = '<p class="err">Failed to load.</p>'; return; }
  const rows = await r.json();
  countEl.textContent = rows.length + (rows.length === 1 ? ' submission' : ' submissions');
  listEl.innerHTML = rows.length ? rows.map(card).join('')
                                 : '<p class="empty">Nothing here.</p>';
}

listEl.addEventListener('click', async (e) => {
  const edit = e.target.closest('button[data-edit]');
  if (edit) {
    document.getElementById('ed-' + edit.dataset.edit).hidden = false;
    document.getElementById('act-' + edit.dataset.edit).hidden = true;
    return;
  }
  const cancel = e.target.closest('button[data-cancel]');
  if (cancel) {
    document.getElementById('ed-' + cancel.dataset.cancel).hidden = true;
    document.getElementById('act-' + cancel.dataset.cancel).hidden = false;
    return;
  }
  const pub = e.target.closest('button[data-pub]');
  if (pub) {
    const id = pub.dataset.pub;
    const msg = document.getElementById('msg-' + id);
    const val = (p) => document.getElementById(p + '-' + id).value.trim();
    pub.disabled = true;
    msg.className = 'pubmsg';
    msg.textContent = 'Opening pull request\u2026';
    const r = await fetch('/admin/submissions/' + id + '/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        title: val('t'), year: val('y'), usccb_code: val('u'),
        mpaa_rating: val('m'), synopsis: val('s'),
      }),
    });
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      msg.className = 'pubmsg err';
      msg.textContent = (d && d.message) || ('Failed (' + r.status + ')');
      pub.disabled = false;
      return;
    }
    msg.className = 'pubmsg ok';
    msg.innerHTML = 'PR opened \u2014 <a href="' + esc(d.pr) + '" target="_blank" rel="noopener noreferrer">'
      + 'review and merge to publish</a>. Slug <code>' + esc(d.slug) + '</code>.';
    return;
  }
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  b.disabled = true;
  const r = await fetch('/admin/submissions/' + b.dataset.id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ status: b.dataset.to }),
  });
  if (r.status === 401) { location.reload(); return; }
  load();
});

statusEl.addEventListener('change', load);
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
});
load();
</script></body></html>`);
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS, makeSession, verifySession, readCookie, timingSafeEqual };
