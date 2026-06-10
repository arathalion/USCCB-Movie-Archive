-- Harden SECURITY DEFINER functions so they aren't exposed as public RPC endpoints.
-- is_moderator() is only needed by RLS policy evaluation for authenticated users.
-- The trigger function should never be called directly.

revoke execute on function public.is_moderator() from public;
grant  execute on function public.is_moderator() to authenticated;

revoke execute on function public.log_submission_status_change() from public;
