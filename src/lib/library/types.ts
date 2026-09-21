/** Domain types. These mirror the SQL schema in supabase/migrations/0001_schema.sql. */

export interface Artist {
  id: string;
  name: string;
  sort_name: string | null;
  bio: string | null;
  image_path: string | null;
  created_at: string;
}

export interface Album {
  id: string;
  artist_id: string | null;
  title: string;
  sort_title: string | null;
  year: number | null;
  genre: string | null;
  cover_path: string | null;
  created_at: string;
  /** Present when the query asked for the nested artist. */
  artist?: Pick<Artist, 'id' | 'name'> | null;
  /** Aggregates filled in by the service, not columns. */
  track_count?: number;
  total_duration?: number;
}

export interface Track {
  id: string;
  album_id: string | null;
  artist_id: string | null;
  title: string;
  track_no: number | null;
  disc_no: number | null;
  duration_seconds: number | null;
  audio_path: string;
  mime_type: string | null;
  file_size: number | null;
  genre: string | null;
  year: number | null;
  created_at: string;
  album?: (Pick<Album, 'id' | 'title' | 'cover_path' | 'year'> & {
    artist?: Pick<Artist, 'id' | 'name'> | null;
  }) | null;
  artist?: Pick<Artist, 'id' | 'name'> | null;
}

export interface Playlist {
  id: string;
  name: string;
  description: string | null;
  cover_path: string | null;
  created_at: string;
  updated_at: string;
  track_count?: number;
}

export interface PlaylistTrack {
  id: string;
  playlist_id: string;
  track_id: string;
  position: number;
  added_at: string;
  track?: Track;
}

export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** Artwork a UI element can render: either a real path or a generated fallback. */
export interface Artwork {
  path: string | null;
  seed: string;
}

export function trackArtwork(track: Track): Artwork {
  return { path: track.album?.cover_path ?? null, seed: track.album?.title ?? track.title };
}

/** Display artist for a track, falling back through album then "Unknown". */
export function trackArtistName(track: Track): string {
  return track.artist?.name ?? track.album?.artist?.name ?? 'Unknown Artist';
}
