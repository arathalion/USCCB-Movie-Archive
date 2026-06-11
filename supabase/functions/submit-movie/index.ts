// Public movie-submission endpoint (Phase 4).
//
// Why an Edge Function instead of a direct anon INSERT: the publishable key is
// shipped to the browser and the table's INSERT grant would otherwise be open,
// so a client-only captcha is bypassable by POSTing straight to PostgREST. This
// function is the ONLY write path — anon INSERT on movie_submissions is revoked.
// It verifies the Cloudflare Turnstile token server-side, validates input, then
// inserts with the service role (bypassing RLS) using exactly the safe columns.
//
// Env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected by the runtime):
//   TURNSTILE_SECRET  Cloudflare Turnstile secret key. If unset, falls back to
//                     Cloudflare's "always passes" TEST secret so the function is
//                     functional on first deploy — set the real secret for prod.

const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Cloudflare's documented test secret (always passes). Replace via the
// TURNSTILE_SECRET edge-function secret in production.
const TEST_SECRET = "1x0000000000000000000000000000000AA";

const USCCB_CODES = new Set(["A-I", "A-II", "A-III", "A-IV", "L", "O"]);
const MPAA_RATINGS = new Set(["G", "PG", "PG-13", "R", "NC-17", "Not Rated"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Trim, collapse to null when empty, and enforce a max length.
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET") || TEST_SECRET;
  if (!Deno.env.get("TURNSTILE_SECRET")) {
    console.warn("TURNSTILE_SECRET not set — using Cloudflare test secret (no real protection).");
  }
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch(TURNSTILE_VERIFY, { method: "POST", body: form });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error("Turnstile verify failed:", e);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // --- Captcha ---
  const token = typeof payload.turnstileToken === "string" ? payload.turnstileToken : "";
  if (!token) return json({ error: "Missing captcha. Please complete the challenge." }, 400);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null;
  if (!(await verifyTurnstile(token, ip))) {
    return json({ error: "Captcha verification failed. Please try again." }, 400);
  }

  // --- Validate fields (mirrors the old anon-insert RLS check: pending + no moderation fields) ---
  const title = str(payload.title, 300);
  if (!title) return json({ error: "Title is required." }, 400);

  let year: number | null = null;
  if (payload.year !== null && payload.year !== undefined && payload.year !== "") {
    const y = Number(payload.year);
    const maxYear = new Date().getFullYear() + 2;
    if (!Number.isInteger(y) || y < 1880 || y > maxYear) {
      return json({ error: `Year must be a whole number between 1880 and ${maxYear}.` }, 400);
    }
    year = y;
  }

  const usccb_code = str(payload.usccb_code, 8);
  if (usccb_code && !USCCB_CODES.has(usccb_code)) {
    return json({ error: "Unknown USCCB rating." }, 400);
  }

  const mpaa_rating = str(payload.mpaa_rating, 16);
  if (mpaa_rating && !MPAA_RATINGS.has(mpaa_rating)) {
    return json({ error: "Unknown MPAA rating." }, 400);
  }

  const source_url = str(payload.source_url, 2000);
  if (source_url && !/^https?:\/\//i.test(source_url)) {
    return json({ error: "Source URL must start with http:// or https://" }, 400);
  }

  const row = {
    title,
    year,
    usccb_code,
    mpaa_rating,
    explanation: str(payload.explanation, 5000),
    source_url,
    submitter_name: str(payload.submitter_name, 120),
    // status defaults to 'pending'; moderation columns left untouched.
  };

  // --- Insert via service role (bypasses RLS; this function is the trusted gate) ---
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${url}/rest/v1/movie_submissions`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    console.error("Insert failed:", res.status, await res.text());
    return json({ error: "Could not save your submission. Please try again later." }, 502);
  }

  return json({ ok: true });
});
