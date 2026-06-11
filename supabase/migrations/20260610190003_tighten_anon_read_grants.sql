-- Continue tightening anon down to least privilege on the public-read tables:
-- anon only ever reads these (build, live browse, SQL runner), never writes.
-- RLS already blocks anon writes; this removes the unused write grants entirely.

revoke all on table public.movies         from anon;
revoke all on table public.usccb_ratings  from anon;
revoke all on table public.genres         from anon;
revoke all on table public.movie_genres   from anon;

grant select on table public.movies        to anon;
grant select on table public.usccb_ratings to anon;
grant select on table public.genres        to anon;
grant select on table public.movie_genres  to anon;
