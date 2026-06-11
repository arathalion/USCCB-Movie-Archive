-- Move 8 "see other title" redirect stubs that slipped past the 230001 extraction
-- into the redirects table. They were missed because their synopsis uses a slightly
-- different "(see: …)" wording (leading year, mid-string "Title (see: …)", etc.)
-- than the pattern 230001 matched, so they lingered in movies as ratingless,
-- synopsis-only rows. Targets parsed by hand: 6 resolve to a film in the archive,
-- 2 point to titles not present (left null, matching the 17 already-unresolved).
-- Deleting them from movies cascades away the bogus movie_tmdb (3) / movie_genres (6)
-- rows three of them had incorrectly picked up during TMDB enrichment.

insert into public.redirects (id, slug, title, synopsis, letter, source_file, target_title, target_movie_id)
values
  (84,    'africanfury',                             'African Fury',                  '(see: 1952''s " Cry, the Beloved Country ")', 'a', 'a/africanfury.shtml',                             'Cry, the Beloved Country',         2559),
  (207,   'allthisandglamourtoo',                    'All This and Glamour Too',      '(see: " Vogues of 1938 ")',                   'a', 'a/allthisandglamourtoo.shtml',                    'Vogues of 1938',                   12946),
  (570,   'theadventuresofjacklondon',               'The Adventures of Jack London', '(see: " Jack London ")',                      'a', 'a/theadventuresofjacklondon.shtml',               'Jack London',                      5931),
  (708,   'bachelorknight',                          'Bachelor Knight',               '(see: "The Bachelor and the Bobby-Soxer" )',  'b', 'b/bachelorknight.shtml',                          'The Bachelor and the Bobby-Soxer', null),
  (934,   'bengalrifles',                            'Bengal Rifles',                 '(see: "Bengal Brigade" )',                    'b', 'b/bengalrifles.shtml',                            'Bengal Brigade',                   933),
  (997,   'bicyclethieves',                          'The Bicycle Thieves',           'Bicycle Thieves (see: " The Bicycle Thief ")','b', 'b/bicyclethieves.shtml',                          'The Bicycle Thief',                1571),
  (2916,  'deathofahooker',                          'Death of a Hooker',             '(see: " Who Killed Mary What''s''ername ")',  'd', 'd/deathofahooker.shtml',                          'Who Killed Mary What''s''ername',  null),
  (10454, 'scroogefor1951versionseeachristmascarol', 'Scrooge',                       '( for 1951 version, see: "A Christmas Carol" )','s','s/scroogefor1951versionseeachristmascarol.shtml','A Christmas Carol',                1773);

delete from public.movies where id in (84,207,570,708,934,997,2916,10454);
