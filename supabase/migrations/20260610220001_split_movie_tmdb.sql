-- Refactor: separate the canonical archive (movies, fixed 1905–2011) from the
-- external TMDB enrichment (sparse, refreshable, may grow). The TMDB fields move
-- to a 1:1 child table movie_tmdb; the two unused "future date" columns are dropped.
-- At 13k rows this is about clarity/provenance, not speed.

create table public.movie_tmdb (
  movie_id          integer primary key references public.movies(id) on delete cascade,
  tmdb_id           integer,                      -- not unique: USCCB has dup entries / re-releases
  tmdb_title        text,
  tmdb_release_date date,
  poster_path       text,
  backdrop_path     text,                         -- room to grow (not captured yet)
  overview          text,
  popularity        real,
  vote_average      real,
  enriched_at       timestamptz not null default now()
);
create index movie_tmdb_tmdb_id_idx on public.movie_tmdb (tmdb_id) where tmdb_id is not null;

-- Public read, moderator write (mirrors the other canonical tables).
alter table public.movie_tmdb enable row level security;
create policy movie_tmdb_public_read on public.movie_tmdb for select to anon, authenticated using (true);
create policy movie_tmdb_mod_write   on public.movie_tmdb for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

-- The project auto-grants ALL to anon/authenticated on new tables — strip to read-only.
revoke all on table public.movie_tmdb from anon, authenticated;
grant select on table public.movie_tmdb to anon, authenticated;

-- The public API view depends on the columns we're dropping; recreate it over the join.
drop view if exists public.public_movies_api;

alter table public.movies
  drop column tmdb_id,
  drop column tmdb_title,
  drop column tmdb_release_date,
  drop column poster_path,
  drop column overview,
  drop column tmdb_enriched_at,
  drop column publication_date,
  drop column theatrical_release_date;

create view public.public_movies_api with (security_invoker = true) as
select
  m.id, m.slug, m.title, m.year, m.usccb_code, m.mpaa_rating, m.synopsis,
  t.tmdb_id, t.poster_path, t.tmdb_release_date, t.overview
from public.movies m
left join public.movie_tmdb t on t.movie_id = m.id
where m.is_redirect = false;

grant select on public.public_movies_api to anon, authenticated;
