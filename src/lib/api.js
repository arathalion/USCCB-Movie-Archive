// Client-side access to the Cloudflare Worker API that replaced Supabase.
// PUBLIC_API_BASE is inlined into the browser bundle at build time (Astro
// exposes only PUBLIC_*-prefixed vars), so it must be a public URL.

export const API_BASE = (
  import.meta.env.PUBLIC_API_BASE || 'http://127.0.0.1:8788'
).replace(/\/+$/, '');

export const REST = `${API_BASE}/rest/v1`;

/** GET a REST resource. `params` is an object of PostgREST-style query params. */
export async function apiGet(resource, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}/${resource}${qs ? `?${qs}` : ''}`);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).message || msg; } catch { /* non-JSON error */ }
    throw new Error(msg);
  }
  return res.json();
}

/** POST to an RPC endpoint (currently only run_read_only_sql). */
export async function apiRpc(fn, body) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`);
  return data;
}
