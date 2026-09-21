-- ===========================================================================
-- Resonance - Row Level Security
-- Run this second.
--
-- The guarantee: a client holding nothing but the project URL and the
-- publishable (anon) key can read and write *only* rows whose owner_id equals
-- its own authenticated user id. An unauthenticated client sees nothing.
-- This is what makes it safe to ship those two values to a browser.
-- ===========================================================================

alter table public.artists          enable row level security;
alter table public.albums           enable row level security;
alter table public.tracks           enable row level security;
alter table public.playlists        enable row level security;
alter table public.playlist_tracks  enable row level security;
alter table public.play_history     enable row level security;
alter table public.user_preferences enable row level security;

-- `to authenticated` keeps the anon role out entirely rather than relying on
-- auth.uid() being null; a policy that only compares uid() would still be
-- evaluated for anon, and null comparisons are easy to get subtly wrong.

do $$
declare
  t text;
begin
  foreach t in array array[
    'artists', 'albums', 'tracks', 'playlists',
    'playlist_tracks', 'play_history'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid())',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())',
      t || '_delete_own', t);
  end loop;
end;
$$;

drop policy if exists user_preferences_all_own on public.user_preferences;
create policy user_preferences_all_own on public.user_preferences
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
