-- Move the SECURITY DEFINER helpers out of the API-exposed `public` schema so they
-- are not reachable as PostgREST RPC endpoints. RLS policies and the trigger still
-- call them; only the exposure surface changes.

create schema if not exists private;
grant usage on schema private to authenticated;  -- needed to call the policy helper

-- Recreate helpers in private
create or replace function private.is_moderator()
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.moderators m where m.user_id = (select auth.uid())
  );
$$;
revoke execute on function private.is_moderator() from public;
grant  execute on function private.is_moderator() to authenticated;

create or replace function private.log_submission_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
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
revoke execute on function private.log_submission_status_change() from public;

-- Re-point the trigger to the private function
drop trigger trg_log_submission_status on movie_submissions;
create trigger trg_log_submission_status
  before update on movie_submissions
  for each row execute function private.log_submission_status_change();

-- Recreate every policy that referenced public.is_moderator()
drop policy ucr_mod_write   on usccb_ratings;
create policy ucr_mod_write   on usccb_ratings for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

drop policy movies_mod_write on movies;
create policy movies_mod_write on movies for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

drop policy genres_mod_write on genres;
create policy genres_mod_write on genres for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

drop policy mg_mod_write on movie_genres;
create policy mg_mod_write on movie_genres for all to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

drop policy subs_mod_select on movie_submissions;
create policy subs_mod_select on movie_submissions for select to authenticated
  using (private.is_moderator());

drop policy subs_mod_update on movie_submissions;
create policy subs_mod_update on movie_submissions for update to authenticated
  using (private.is_moderator()) with check (private.is_moderator());

drop policy evt_mod_select on submission_review_events;
create policy evt_mod_select on submission_review_events for select to authenticated
  using (private.is_moderator());

drop policy evt_mod_insert on submission_review_events;
create policy evt_mod_insert on submission_review_events for insert to authenticated
  with check (private.is_moderator());

drop policy mods_read on moderators;
create policy mods_read on moderators for select to authenticated
  using (user_id = (select auth.uid()) or private.is_moderator());

-- Drop the now-unreferenced public helpers
drop function public.is_moderator();
drop function public.log_submission_status_change();
