-- Public read-only API for external sites, served via PostgREST.
-- security_invoker = true → the view runs under the caller's RLS (anon sees only
-- the public_read rows). It exposes a curated, safe subset of movie columns.

create view public_movies_api with (security_invoker = true) as
select
  id,
  slug,
  title,
  year,
  usccb_code,
  mpaa_rating,
  synopsis,
  tmdb_id,
  poster_path,
  theatrical_release_date,
  publication_date
from movies
where is_redirect = false;

grant select on public_movies_api to anon, authenticated;
