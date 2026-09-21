-- ===========================================================================
-- Resonance - Storage bucket + policies
-- Run this third.
--
-- The bucket is PRIVATE. Audio is reached through short-lived signed URLs the
-- app mints on demand, so nothing is world-readable and no object key is a
-- credential on its own.
--
-- Object key layout (the first path segment is the owner's user id, which is
-- what the policies below match on):
--
--   <owner-uuid>/albums/<album-id>/cover.jpg
--   <owner-uuid>/albums/<album-id>/01-track-title.mp3
--   <owner-uuid>/artists/<artist-id>/image.jpg
--   <owner-uuid>/playlists/<playlist-id>/cover.jpg
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('music', 'music', false, 209715200)   -- 200 MB per object
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

drop policy if exists "music_read_own"   on storage.objects;
drop policy if exists "music_insert_own" on storage.objects;
drop policy if exists "music_update_own" on storage.objects;
drop policy if exists "music_delete_own" on storage.objects;

-- storage.foldername(name) splits the object key on '/', so [1] is the
-- owner-uuid prefix above.
create policy "music_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "music_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "music_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "music_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
