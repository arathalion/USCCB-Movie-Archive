-- Manually-researched target resolutions for 5 redirects the automatic
-- (article-insensitive) matcher in 230001 missed: Roman-vs-Arabic numerals,
-- a "File"/"Files" typo, and sequel naming differences. Keyed on the unique
-- stub title → the resolved movie id. Brings resolved redirects to 305/322;
-- the remaining 17 point to films genuinely not in the archive.
update public.redirects r set target_movie_id = v.mid
from (values
  ('Robert A. Heinlein''s The Puppet Masters', 9550),  -- → Puppet Masters, The (1994)
  ('Hideaways, The',                            4158),  -- → From the Mixed-Up Files of Mrs. Basil E. Frankweiler
  ('History Of The World, Part I',              7646),  -- → Mel Brooks' History of the World, Part 1
  ('Sounder, Part II',                          9041),  -- → Part 2, Sounder (1976 sequel)
  ('Walking Tall, Part II',                     9042)   -- → Part 2, Walking Tall (1975 sequel)
) as v(stub, mid)
where r.title = v.stub and r.target_movie_id is null;
