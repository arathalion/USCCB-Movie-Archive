-- Phase 8 (moderator admin SPA): make `authenticated` privileges on `movies`
-- deterministic and least-privilege.
--
-- Background: the project auto-grants ALL to anon AND authenticated on every new
-- public table (the auto-RLS setting). Earlier migrations tightened anon down to
-- SELECT on the canonical read tables (190003) and stripped authenticated on
-- movie_submissions (200001), but `authenticated` on `movies` was never narrowed —
-- it still carries the auto-granted ALL. The admin's "import to movies" flow writes
-- `movies` from the browser as a signed-in moderator (under the movies_mod_write
-- RLS policy), so authenticated genuinely needs INSERT/UPDATE/DELETE here — but not
-- TRUNCATE/REFERENCES/TRIGGER. Pin the grant to exactly what the policy allows.
--
-- RLS still gates rows (movies_mod_write requires private.is_moderator()); this only
-- removes the unused excess privileges so a future policy regression isn't a loaded gun.

revoke all on table public.movies from authenticated;
grant select, insert, update, delete on table public.movies to authenticated;
