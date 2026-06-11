-- Defense-in-depth: the project's default privileges grant anon ALL on every
-- public table. RLS already blocks anon on the protected tables, but anon should
-- not hold INSERT/UPDATE/DELETE/etc on them at all — if a policy ever regresses,
-- those grants would be a loaded gun. Strip anon down to exactly what it needs:
-- insert-only on movie_submissions (the public /submit path), nothing else here.

revoke all on table public.moderators                from anon;
revoke all on table public.submission_review_events  from anon;
revoke all on table public.movie_submissions         from anon;
grant  insert on table public.movie_submissions      to anon;
