-- Move the 322 "see other title" alias stubs out of `movies` into their own table,
-- so `movies` holds only real films and the is_redirect filter footgun goes away.
-- Original ids/slugs/text are preserved so the legacy SQLite/CSV download can be
-- rebuilt by export_sqlite.mjs (UNION of movies + redirects).

create table public.redirects (
  id              integer primary key,            -- original movies.id of the stub
  slug            text not null unique,
  title           text not null,                  -- the alias/stub title
  synopsis        text,                           -- original '(see: "Target")' text
  letter          char(1),
  source_file     text,
  target_title    text,                           -- parsed target name
  target_movie_id integer references public.movies(id) on delete set null,  -- best-effort
  created_at      timestamptz not null default now()
);

-- 1) copy the stubs over, parsing the target title out of the synopsis.
insert into public.redirects (id, slug, title, synopsis, letter, source_file, target_title)
select
  m.id, m.slug, m.title, m.synopsis, m.letter, m.source_file,
  coalesce(
    nullif(trim(substring(m.synopsis from '"\s*(.*?)\s*"')), ''),
    nullif(trim(both ' "''' from regexp_replace(regexp_replace(m.synopsis, '^\(\s*see\s*:?\s*', '', 'i'), '\s*\)\s*$', '')), '')
  )
from public.movies m
where m.is_redirect;

-- 2) remove the stubs from movies (nothing FKs to them).
delete from public.movies where is_redirect;

-- 3) best-effort resolve target_movie_id against the real films (article-insensitive key).
update public.redirects r set target_movie_id = mk.id
from (
  select id,
    regexp_replace(lower(regexp_replace(regexp_replace(title, ',\s*(the|a|an)\.?$', '', 'i'), '^(the|a|an|la|le|les|el|il|lo|los|las)\s+', '', 'i')), '[^a-z0-9]', '', 'g') as mkey
  from public.movies
) mk
where r.target_title is not null
  and regexp_replace(lower(regexp_replace(r.target_title, '^(the|a|an|la|le|les|el|il|lo|los|las)\s+', '', 'i')), '[^a-z0-9]', '', 'g') <> ''
  and mk.mkey = regexp_replace(lower(regexp_replace(r.target_title, '^(the|a|an|la|le|les|el|il|lo|los|las)\s+', '', 'i')), '[^a-z0-9]', '', 'g');

-- 4) the public API view references is_redirect; recreate it without that filter
--    (movies is now all real films), then drop the column.
drop view if exists public.public_movies_api;

alter table public.movies drop column is_redirect;

create view public.public_movies_api with (security_invoker = true) as
select
  m.id, m.slug, m.title, m.year, m.usccb_code, m.mpaa_rating, m.synopsis,
  t.tmdb_id, t.poster_path, t.tmdb_release_date, t.overview
from public.movies m
left join public.movie_tmdb t on t.movie_id = m.id;
grant select on public.public_movies_api to anon, authenticated;

-- 5) RLS + least-privilege grants for the new public-read table.
alter table public.redirects enable row level security;
create policy redirects_public_read on public.redirects for select to anon, authenticated using (true);
create policy redirects_mod_write   on public.redirects for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());
revoke all on table public.redirects from anon, authenticated;
grant select on table public.redirects to anon, authenticated;
