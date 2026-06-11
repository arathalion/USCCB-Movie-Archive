-- Phase 5: the browse page gains an A–Z letter bar that filters on movies.letter
-- (the source-folder bucket, which is article-aware: "The Bear" → 'b'). Index it
-- so the equality filter stays cheap alongside the other browse filters.
create index if not exists movies_letter_idx on public.movies (letter);
