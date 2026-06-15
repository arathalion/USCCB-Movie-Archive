# Moderation (admin SPA)

Phase 8 of the migration: a moderator-only admin page for reviewing public
submissions. It lives at **`/admin`** (e.g. `https://<user>.github.io/<repo>/admin/`)
and is intentionally **not linked** from the public navigation.

## What it is

A single client-rendered page (`src/pages/admin/index.astro`). The site is static
(GitHub Pages), so there is no server — the admin talks to Supabase **directly from
the browser** as the signed-in moderator. **Row Level Security is the only security
boundary**; the UI gate is cosmetic. A signed-out (or non-moderator) browser making
the same PostgREST calls is denied by RLS.

It uses the public `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` (same as
`/submit` and `/query`) plus a moderator's Supabase Auth session.

## Capabilities

- **Sign in / out** with email + password (Supabase Auth `signInWithPassword`).
  The session persists in `localStorage` and auto-refreshes.
- **List submissions** filtered by status (`pending` by default; also
  `needs_more_info`, `approved`, `imported`, `rejected`, `duplicate`, `all`).
- **Review a submission**: change `status`, write `admin_notes`, set
  `linked_movie_id` (for `duplicate`/`imported`). The `before update` trigger
  (`private.log_submission_status_change`) auto-records a `submission_review_events`
  row and stamps `reviewed_by`/`reviewed_at` on every status change.
- **Import to movies**: creates a new `movies` row from the submission (assigning
  `max(id)+1` and a unique slug, article-aware `letter`), then marks the submission
  `imported` and links it. The new film goes live on the **next site rebuild**.
- **Review history** per submission.

## Seeding a moderator

There are **no public accounts** — only moderators have Supabase Auth users.
To add one:

1. **Supabase Dashboard → Authentication → Users → Add user** (set an email +
   password, or invite). Copy the new user's **UUID**.
2. Insert the moderator row (Studio SQL editor or `psql`, service role):

   ```sql
   insert into public.moderators (user_id, email, display_name)
   values ('<auth-user-uuid>', 'mod@example.com', 'Jane Moderator');
   ```

3. The user can now sign in at `/admin`. (Without the `moderators` row they'll see
   "Not authorized" — RLS denies reads.)

## Required grant

The "Import to movies" flow writes `movies` from the browser as the moderator. That
needs an explicit table grant for the `authenticated` role (RLS still gates rows via
`movies_mod_write`):

```sql
revoke all on table public.movies from authenticated;
grant select, insert, update, delete on table public.movies to authenticated;
```

This is migration `20260615280001_grant_movies_write_to_moderators.sql`. Apply it
to the project (`supabase db push`, the Studio SQL editor, or the migration tooling)
before relying on import. Reads, status changes, and notes work without it.

## Notes / limits

- Imported films are **canonical immediately in Postgres** but only appear on the
  static site after a rebuild/redeploy (browse + detail pages are built from
  Postgres). Trigger a deploy when you want approved/imported films to publish.
- `movies.id` is a plain integer PK (it preserves the original archive ids), so
  import assigns `max(id)+1` client-side. With a single moderator this is safe; it
  is not concurrency-hardened for simultaneous importers.
- The import form does not attach TMDB data or genres — run the TMDB pipeline
  (`scripts/tmdb_match.py` → `apply_tmdb.mjs`) afterward if enrichment is wanted.
