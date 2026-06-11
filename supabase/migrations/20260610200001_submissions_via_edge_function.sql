-- Phase 4: route public submissions exclusively through the submit-movie Edge
-- Function. The function verifies a Cloudflare Turnstile token server-side and
-- inserts with the service role, so direct anon INSERT is no longer the path and
-- is revoked here (defense in depth — the publishable key is shipped to clients).

-- Drop the old open anon-insert path.
drop policy if exists subs_anon_insert on public.movie_submissions;
revoke insert on table public.movie_submissions from anon;

-- Tighten `authenticated` to exactly what moderator RLS needs (select + update).
-- The project auto-grants ALL to authenticated on every public table; strip the
-- unused INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER so a future RLS regression
-- can't be exploited. (Studio moderation runs as the admin role, unaffected.)
revoke all on table public.movie_submissions from authenticated;
grant select, update on table public.movie_submissions to authenticated;
