-- D1 (SQLite) schema mirroring the Postgres shape the public API was built on.
-- Column names and nullability match docs/api.md so the documented contract
-- survives the move off Supabase.

DROP TABLE IF EXISTS movie_genres;
DROP TABLE IF EXISTS movie_tmdb;
DROP TABLE IF EXISTS redirects;
DROP TABLE IF EXISTS genres;
DROP TABLE IF EXISTS usccb_ratings;
DROP TABLE IF EXISTS movies_fts;
DROP TABLE IF EXISTS movies;
DROP VIEW  IF EXISTS public_movies_api;

CREATE TABLE usccb_ratings (
  code        TEXT PRIMARY KEY,
  label       TEXT,
  description TEXT,
  sort_order  INTEGER
);

CREATE TABLE movies (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  year        INTEGER,
  usccb_code  TEXT REFERENCES usccb_ratings(code),
  mpaa_rating TEXT,
  synopsis    TEXT,
  full_review TEXT,
  letter      TEXT,
  source_file TEXT
);
CREATE INDEX idx_movies_year   ON movies(year);
CREATE INDEX idx_movies_usccb  ON movies(usccb_code);
CREATE INDEX idx_movies_mpaa   ON movies(mpaa_rating);
CREATE INDEX idx_movies_letter ON movies(letter);
CREATE INDEX idx_movies_title  ON movies(title);

CREATE TABLE movie_tmdb (
  movie_id          INTEGER PRIMARY KEY REFERENCES movies(id),
  tmdb_id           INTEGER,
  tmdb_title        TEXT,
  tmdb_release_date TEXT,
  poster_path       TEXT,
  backdrop_path     TEXT,
  overview          TEXT,
  popularity        REAL,
  vote_average      REAL,
  enriched_at       TEXT
);

CREATE TABLE genres (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE movie_genres (
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  genre_id INTEGER NOT NULL REFERENCES genres(id),
  PRIMARY KEY (movie_id, genre_id)
);
CREATE INDEX idx_movie_genres_genre ON movie_genres(genre_id);

CREATE TABLE redirects (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT,
  synopsis        TEXT,
  letter          TEXT,
  source_file     TEXT,
  target_title    TEXT,
  target_movie_id INTEGER REFERENCES movies(id)
);

-- Replaces the Postgres tsvector + GIN index. Weighting (title > synopsis >
-- full_review) is applied at query time via bm25() rather than baked into the
-- column, which is the closest FTS5 equivalent.
CREATE VIRTUAL TABLE movies_fts USING fts5(
  title, synopsis, full_review,
  content='movies', content_rowid='id', tokenize='porter unicode61'
);

-- The curated public resource from docs/api.md: safe columns + TMDB + genres.
-- SQLite has no array type, so `genres` is emitted as a JSON array string and
-- parsed back into a real array by the Worker before serialising the response.
CREATE VIEW public_movies_api AS
SELECT
  m.id,
  m.slug,
  m.title,
  m.year,
  m.usccb_code,
  m.mpaa_rating,
  m.synopsis,
  t.tmdb_id,
  t.poster_path,
  t.tmdb_release_date,
  t.overview,
  -- The ORDER BY has to sit in a nested subquery: applied alongside the
  -- aggregate it is ignored, which silently yields unsorted genre arrays.
  COALESCE(
    (SELECT json_group_array(name) FROM (
       SELECT g.name
         FROM movie_genres mg JOIN genres g ON g.id = mg.genre_id
        WHERE mg.movie_id = m.id
        ORDER BY g.name
    )),
    json_array()
  ) AS genres
FROM movies m
LEFT JOIN movie_tmdb t ON t.movie_id = m.id;

-- Public submissions. Written only by the Worker's /submit endpoint after a
-- server-side Turnstile check — the same rule the Supabase Edge Function
-- enforced, carried over so the captcha can't be bypassed from the browser.
-- Column names mirror the /submit form fields exactly (src/pages/submit.astro).
CREATE TABLE IF NOT EXISTS movie_submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  year           INTEGER,
  usccb_code     TEXT,
  mpaa_rating    TEXT,
  explanation    TEXT,
  source_url     TEXT,
  submitter_name TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at    TEXT,
  reviewer       TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON movie_submissions(status, created_at);
