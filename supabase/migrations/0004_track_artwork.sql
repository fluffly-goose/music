-- ===========================================================================
-- Resonance - per-song artwork
--
-- Run this after 0001-0003. It is additive and safe to re-run.
--
-- Until now a song borrowed its album's cover, so singles and loose tracks
-- with no album art showed a plain placeholder. This lets a song carry its
-- own image, falling back to the album's when it has none.
--
-- The app detects whether this column exists and keeps working without it, so
-- running this is optional - you just will not be able to set artwork on an
-- individual song until you do.
-- ===========================================================================

alter table public.tracks
  add column if not exists cover_path text;

comment on column public.tracks.cover_path is
  'Storage key for artwork specific to this song. Null means inherit the album cover.';
