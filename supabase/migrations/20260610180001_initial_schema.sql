-- USCCB Movie Archive — canonical schema
-- Postgres becomes the single source of truth; SQLite becomes a derived export.
-- gen_random_uuid() is available in core Postgres 17 (pgcrypto already installed).

-- ---------- Lookup: USCCB ratings ----------
create table usccb_ratings (
  code        text primary key,            -- 'A-I','A-II','A-III','A-IV','L','O'
  label       text not null,
  description text,
  sort_order  smallint not null
);

insert into usccb_ratings (code, label, description, sort_order) values
  ('A-I',  'A-I',  'General patronage',          1),
  ('A-II', 'A-II', 'Adults and adolescents',     2),
  ('A-III','A-III','Adults',                      3),
  ('A-IV', 'A-IV', 'Adults, with reservations',   4),
  ('L',    'L',    'Limited adult audience',      5),
  ('O',    'O',    'Morally offensive',           6);

-- ---------- Canonical movies (preserve ids 1..13694 from movies_web.db) ----------
create table movies (
  id            integer primary key,
  slug          text not null unique,         -- stable URL contract (from films.json)
  title         text not null,
  year          smallint,
  usccb_code    text references usccb_ratings(code),  -- was cns_rating
  mpaa_rating   text,
  synopsis      text,
  full_review   text,                         -- \n\n paragraph breaks preserved
  letter        char(1),                      -- source folder a-z
  source_file   text,                         -- was filename
  is_redirect   boolean not null default false,

  -- TMDB enrichment (nullable; filled by the Phase 6 pipeline)
  tmdb_id            integer,
  tmdb_title         text,
  tmdb_release_date  date,
  poster_path        text,
  overview           text,
  tmdb_enriched_at   timestamptz,

  -- Future date fields (not in the current archive data)
  publication_date         date,
  theatrical_release_date  date,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Full-text search column (replaces SQLite FTS5). The explicit 'english' regconfig
-- makes to_tsvector immutable, which generated columns require.
alter table movies add column search_tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title,'')),      'A') ||
  setweight(to_tsvector('english', coalesce(synopsis,'')),   'B') ||
  setweight(to_tsvector('english', coalesce(full_review,'')),'C')
) stored;

-- ---------- Genres ----------
create table genres (
  id            integer primary key generated always as identity,
  name          text not null unique,
  tmdb_genre_id integer unique
);

create table movie_genres (
  movie_id integer not null references movies(id) on delete cascade,
  genre_id integer not null references genres(id) on delete cascade,
  primary key (movie_id, genre_id)
);

-- ---------- Moderators (only moderators have auth accounts; public never does) ----------
create table moderators (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  created_at   timestamptz not null default now()
);

-- ---------- Public submissions (no email collected; optional name only) ----------
create type submission_status as enum
  ('pending','approved','rejected','needs_more_info','duplicate','imported');

create table movie_submissions (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  year            smallint,
  usccb_code      text references usccb_ratings(code),  -- suggested rating
  mpaa_rating     text,
  explanation     text,                       -- justification
  source_url      text,
  submitter_name  text,                       -- optional; no email field by design
  status          submission_status not null default 'pending',
  admin_notes     text,
  reviewed_by     uuid references moderators(user_id),
  reviewed_at     timestamptz,
  linked_movie_id integer references movies(id),  -- set on import / duplicate
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- Submission review history ----------
create table submission_review_events (
  id            bigint primary key generated always as identity,
  submission_id uuid not null references movie_submissions(id) on delete cascade,
  moderator_id  uuid references moderators(user_id),
  from_status   submission_status,
  to_status     submission_status not null,
  note          text,
  created_at    timestamptz not null default now()
);
