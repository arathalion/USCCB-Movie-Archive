-- Phase 7: public read-only API surface.
-- Recreate public_movies_api adding an aggregated genres[] so consumers get
-- genre names in one request, and tighten grants: the project auto-grants ALL
-- to anon/authenticated even on views (the 230001 recreate only added SELECT
-- without first revoking), so anon/authenticated were left holding
-- INSERT/UPDATE/DELETE/TRUNCATE on the view. Not exploitable (security_invoker
-- join view → not auto-updatable, underlying RLS still applies) but it violates
-- our revoke-all-then-narrow-grant invariant. Fix both here.

drop view if exists public.public_movies_api;

create view public.public_movies_api with (security_invoker = true) as
select
  m.id, m.slug, m.title, m.year, m.usccb_code, m.mpaa_rating, m.synopsis,
  t.tmdb_id, t.poster_path, t.tmdb_release_date, t.overview,
  coalesce(
    (select array_agg(g.name order by g.name)
       from public.movie_genres mg
       join public.genres g on g.id = mg.genre_id
      where mg.movie_id = m.id),
    '{}'::text[]
  ) as genres
from public.movies m
left join public.movie_tmdb t on t.movie_id = m.id;

-- Read-only public surface (strip the auto-granted writes first).
revoke all on public.public_movies_api from anon, authenticated;
grant select on public.public_movies_api to anon, authenticated;
