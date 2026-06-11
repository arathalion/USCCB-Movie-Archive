-- Remove 158 "completely empty" placeholder records: real films whose archived
-- USCCB .shtml page contained only the generic legend boilerplate (dead/placeholder
-- links at crawl time), so they carry no USCCB rating, no MPAA rating, no synopsis,
-- and no full review — only a title. They add nothing to an archive of reviews and
-- show as blank entries. 151 had a TMDB poster attached during enrichment; that's
-- incidental (not USCCB content) and cascades away via movie_tmdb/movie_genres
-- (both ON DELETE CASCADE). Predicate-based so it stays correct on a re-import.
delete from public.movies m
where m.usccb_code is null
  and m.mpaa_rating is null
  and coalesce(m.synopsis, '') = ''
  and coalesce(m.full_review, '') = '';
