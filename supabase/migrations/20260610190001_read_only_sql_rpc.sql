-- Server-side read-only SQL runner for the public /query page (power users).
--
-- Safety model (defense in depth):
--   * SECURITY INVOKER — executes as the calling role (anon), so existing RLS +
--     table grants already limit it to public-read tables. anon cannot read
--     moderators / submissions / auth.* / the private schema.
--   * SET LOCAL transaction_read_only = on — blocks ANY write/DDL even if a
--     statement slips past parsing (neutralizes anon's INSERT grant on
--     movie_submissions).
--   * statement_timeout = 5s and a hard 1000-row cap bound resource use.
--   * Single statement, SELECT/WITH only.
-- Returns SETOF jsonb (one object per row) so ORDER BY is preserved and PostgREST
-- serializes it as a JSON array.

create or replace function public.run_read_only_sql(query text)
returns setof jsonb
language plpgsql
security invoker          -- runs as the caller (anon); RLS + grants restrict it
set search_path = public  -- fixed (not role-mutable); lets users write unqualified table names
as $$
declare
  cleaned text := rtrim(btrim(query), E';\n\r\t ');
begin
  if cleaned = '' then
    raise exception 'Enter a query.';
  end if;
  if position(';' in cleaned) > 0 then
    raise exception 'Only a single statement is allowed (remove extra ";").';
  end if;
  if lower(cleaned) !~ '^(with|select)\s' then
    raise exception 'Only SELECT / WITH queries are allowed.';
  end if;

  set local statement_timeout = '5s';
  set local transaction_read_only = on;

  return query execute
    format('select to_jsonb(t) from (select * from (%s) _q limit 1000) t', cleaned);
end;
$$;

revoke execute on function public.run_read_only_sql(text) from public;
grant  execute on function public.run_read_only_sql(text) to anon, authenticated;
