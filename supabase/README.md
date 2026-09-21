# Supabase setup

Run these three files in order, in your project's **SQL Editor**.

| Order | File | Purpose |
|---|---|---|
| 1 | `migrations/0001_schema.sql` | Tables, indexes, the playlist `updated_at` trigger |
| 2 | `migrations/0002_rls.sql` | Row Level Security on every table |
| 3 | `migrations/0003_storage.sql` | The private `music` bucket and its access policies |

They are idempotent — re-running them is safe.

## After the migrations

1. **Authentication → Users → Add user** (email + password, "Auto Confirm User").
2. Copy that user's UUID. The import script needs it as `SUPABASE_OWNER_ID`.
3. **Settings → API Keys** → copy the **publishable** (or legacy **anon**) key
   for the app. Never the `service_role` / `sb_secret_` key.

## Schema

```
artists ──┬─< albums ──┬─< tracks
          └────────────┴─────┘        (tracks link to both)

playlists ──< playlist_tracks >── tracks
play_history >── tracks
user_preferences (one row per owner)
```

Every table has `owner_id uuid not null default auth.uid()` referencing
`auth.users`. That column is the entire multi-tenancy story: one Supabase
project can hold several independent libraries, and every RLS policy keys off
it.

## What the policies guarantee

- An **anonymous** client (URL + publishable key, not signed in) sees nothing.
  The policies are granted `to authenticated` only.
- An **authenticated** client can read and write only rows where
  `owner_id = auth.uid()`.
- Inserts cannot forge ownership: `owner_id` defaults to `auth.uid()` and the
  `with check` clause rejects anything else.
- **Storage** objects are matched by their first path segment:
  `(storage.foldername(name))[1] = auth.uid()::text`. Your files live under
  `<your-uuid>/…`, and nobody else's key can reach them.

The bucket is private, so every read goes through a short-lived signed URL.

## Verifying it works

In the SQL Editor (which runs as a privileged role, so this only checks the
policies exist):

```sql
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd;
```

You should see four policies (select/insert/update/delete) on each of
`artists`, `albums`, `tracks`, `playlists`, `playlist_tracks`, `play_history`,
plus one `ALL` policy on `user_preferences`.

The real check is the app's own **Test** button on the onboarding screen: it
reports separately whether the tables exist, whether the bucket exists, and
whether you're authenticated.
