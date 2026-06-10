-- Indexes for the canonical archive.

create index movies_usccb_idx       on movies (usccb_code);
create index movies_year_idx        on movies (year);
create index movies_is_redirect_idx on movies (is_redirect);
create unique index movies_tmdb_id_idx on movies (tmdb_id) where tmdb_id is not null;

-- Full-text search index (replaces FTS5). Query with websearch_to_tsquery('english', q).
create index movies_search_idx on movies using gin (search_tsv);

create index movie_submissions_status_idx on movie_submissions (status);
create index submission_review_events_submission_idx on submission_review_events (submission_id);
