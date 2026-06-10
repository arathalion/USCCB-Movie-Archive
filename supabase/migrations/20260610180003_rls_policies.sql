-- Row Level Security. RLS is the real security boundary for this project, because
-- the public site (build + /submit) and the future admin talk to PostgREST directly.

-- Moderator check. SECURITY DEFINER so it can read moderators regardless of that
-- table's own RLS (otherwise policies that call it would recurse). search_path is
-- locked and the body only reveals a boolean about the current user.
create or replace function public.is_moderator()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.moderators m where m.user_id = (select auth.uid())
  );
$$;

-- ===== Explicit Data API grants (RLS still filters rows) =====
grant select on usccb_ratings, movies, genres, movie_genres to anon, authenticated;
grant insert on movie_submissions to anon;
grant select, update on movie_submissions to authenticated;
grant select, insert on submission_review_events to authenticated;
grant select on moderators to authenticated;

-- ===== Canonical tables: public read, moderator write =====
alter table usccb_ratings enable row level security;
create policy ucr_public_read on usccb_ratings for select to anon, authenticated using (true);
create policy ucr_mod_write   on usccb_ratings for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

alter table movies enable row level security;
create policy movies_public_read on movies for select to anon, authenticated using (true);
create policy movies_mod_write   on movies for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

alter table genres enable row level security;
create policy genres_public_read on genres for select to anon, authenticated using (true);
create policy genres_mod_write   on genres for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

alter table movie_genres enable row level security;
create policy mg_public_read on movie_genres for select to anon, authenticated using (true);
create policy mg_mod_write   on movie_genres for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

-- ===== Submissions: anon insert-only (pending, no moderation fields), moderator read/update =====
alter table movie_submissions enable row level security;
create policy subs_anon_insert on movie_submissions for insert to anon
  with check (
    status = 'pending'
    and admin_notes is null
    and reviewed_by is null
    and reviewed_at is null
    and linked_movie_id is null
  );
create policy subs_mod_select on movie_submissions for select to authenticated
  using (public.is_moderator());
create policy subs_mod_update on movie_submissions for update to authenticated
  using (public.is_moderator()) with check (public.is_moderator());
-- (no anon select/update/delete policy → anon cannot read or change submissions)

-- ===== Review events: moderator read + insert =====
alter table submission_review_events enable row level security;
create policy evt_mod_select on submission_review_events for select to authenticated
  using (public.is_moderator());
create policy evt_mod_insert on submission_review_events for insert to authenticated
  with check (public.is_moderator());

-- ===== Moderators table: self / moderator read only =====
alter table moderators enable row level security;
create policy mods_read on moderators for select to authenticated
  using (user_id = (select auth.uid()) or public.is_moderator());

-- ===== Auto-log status changes so review history can't be skipped =====
create or replace function public.log_submission_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.submission_review_events
      (submission_id, moderator_id, from_status, to_status, note)
    values
      (new.id, (select auth.uid()), old.status, new.status, new.admin_notes);
    new.reviewed_by := coalesce(new.reviewed_by, (select auth.uid()));
    new.reviewed_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_log_submission_status
  before update on movie_submissions
  for each row execute function public.log_submission_status_change();
