-- ===========================================================================
-- Resonance - schema
-- Run this first, in the Supabase Dashboard -> SQL Editor.
--
-- Design notes
--  * Every row carries an `owner_id` pointing at auth.users. That single column
--    is what lets one Supabase project hold several independent libraries
--    without ever mixing them, and it is what every RLS policy keys off.
--  * Audio and artwork live in Storage. The database only stores *paths*.
--  * `owner_id` defaults to auth.uid() so an authenticated client never has to
--    (and never gets to) choose who owns a row it inserts.
-- ===========================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- fast ILIKE search

-- ---------------------------------------------------------------------------
-- artists
-- ---------------------------------------------------------------------------
create table if not exists public.artists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  sort_name   text,
  bio         text,
  image_path  text,
  created_at  timestamptz not null default now(),
  unique (owner_id, name)
);

-- ---------------------------------------------------------------------------
-- albums
-- ---------------------------------------------------------------------------
create table if not exists public.albums (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  artist_id   uuid references public.artists(id) on delete set null,
  title       text not null check (length(trim(title)) > 0),
  sort_title  text,
  year        int check (year is null or (year between 1000 and 2999)),
  genre       text,
  cover_path  text,
  created_at  timestamptz not null default now(),
  unique (owner_id, artist_id, title)
);

-- ---------------------------------------------------------------------------
-- tracks
-- `audio_path` is the object key inside the music bucket. It is the only
-- link between a row and the actual bytes.
-- ---------------------------------------------------------------------------
create table if not exists public.tracks (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id         uuid references public.albums(id) on delete cascade,
  artist_id        uuid references public.artists(id) on delete set null,
  title            text not null check (length(trim(title)) > 0),
  track_no         int check (track_no is null or track_no >= 0),
  disc_no          int default 1 check (disc_no is null or disc_no >= 0),
  duration_seconds numeric(10, 3) check (duration_seconds is null or duration_seconds >= 0),
  audio_path       text not null,
  mime_type        text,
  file_size        bigint,
  genre            text,
  year             int check (year is null or (year between 1000 and 2999)),
  created_at       timestamptz not null default now(),
  unique (owner_id, audio_path)
);

-- ---------------------------------------------------------------------------
-- playlists
-- ---------------------------------------------------------------------------
create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  description text,
  cover_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Ordering uses a sparse `position` so a reorder only rewrites the moved row.
create table if not exists public.playlist_tracks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  track_id    uuid not null references public.tracks(id) on delete cascade,
  position    double precision not null,
  added_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- play_history - powers "Recently played" on Home.
-- ---------------------------------------------------------------------------
create table if not exists public.play_history (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id  uuid not null references public.tracks(id) on delete cascade,
  played_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_preferences - one row per library. Free-form JSON so the client can
-- evolve its settings without another migration.
-- ---------------------------------------------------------------------------
create table if not exists public.user_preferences (
  owner_id   uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists artists_owner_idx          on public.artists (owner_id, name);
create index if not exists albums_owner_idx           on public.albums (owner_id, title);
create index if not exists albums_artist_idx          on public.albums (artist_id);
create index if not exists albums_recent_idx          on public.albums (owner_id, created_at desc);
create index if not exists tracks_owner_idx           on public.tracks (owner_id, title);
create index if not exists tracks_album_idx           on public.tracks (album_id, disc_no, track_no);
create index if not exists tracks_artist_idx          on public.tracks (artist_id);
create index if not exists tracks_recent_idx          on public.tracks (owner_id, created_at desc);
create index if not exists playlists_owner_idx        on public.playlists (owner_id, updated_at desc);
create index if not exists playlist_tracks_order_idx  on public.playlist_tracks (playlist_id, position);
create index if not exists play_history_recent_idx    on public.play_history (owner_id, played_at desc);

-- Trigram indexes make the search screen responsive on large libraries.
create index if not exists tracks_title_trgm  on public.tracks  using gin (title gin_trgm_ops);
create index if not exists albums_title_trgm  on public.albums  using gin (title gin_trgm_ops);
create index if not exists artists_name_trgm  on public.artists using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Keep playlists.updated_at honest so "recently edited" ordering works.
-- ---------------------------------------------------------------------------
create or replace function public.touch_playlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.playlists
     set updated_at = now()
   where id = coalesce(new.playlist_id, old.playlist_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists playlist_tracks_touch on public.playlist_tracks;
create trigger playlist_tracks_touch
  after insert or update or delete on public.playlist_tracks
  for each row execute function public.touch_playlist();
