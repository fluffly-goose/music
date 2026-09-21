/**
 * Every database query in the app lives in this file.
 *
 * UI code calls these methods and gets domain objects back; it never sees
 * PostgREST, never builds a filter string, and never learns the table names.
 * That is what lets the schema change without touching a single screen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { connection } from '../connection/manager';
import { toAppError, AppError } from '../utils/errors';
import { sanitizeSearchTerm } from '../utils/format';
import type {
  Album,
  Artist,
  Page,
  Playlist,
  PlaylistTrack,
  SearchResults,
  Track,
} from './types';

/** Column lists kept in one place so every query returns the same shape. */
const TRACK_COLUMNS = `
  id, album_id, artist_id, title, track_no, disc_no, duration_seconds,
  audio_path, mime_type, file_size, genre, year, created_at,
  album:albums ( id, title, cover_path, year, artist:artists ( id, name ) ),
  artist:artists ( id, name )
`;

const ALBUM_COLUMNS = `
  id, artist_id, title, sort_title, year, genre, cover_path, created_at,
  artist:artists ( id, name )
`;

export const DEFAULT_PAGE_SIZE = 50;

export interface PageParams {
  offset?: number;
  limit?: number;
}

class MusicLibraryService {
  private get client(): SupabaseClient {
    return connection.requireClient();
  }

  private ownerId(): string {
    const id = connection.getOwnerId();
    if (!id) {
      throw new AppError('auth-required', 'You need to be signed in to change your library.', {
        hint: 'Sign in from Settings.',
      });
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // Tracks
  // -------------------------------------------------------------------------

  async getTracks(params: PageParams = {}): Promise<Page<Track>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    try {
      const { data, error, count } = await this.client
        .from('tracks')
        .select(TRACK_COLUMNS, { count: 'exact' })
        .order('title', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return this.toPage<Track>(data as unknown as Track[], count, offset);
    } catch (raw) {
      throw toAppError(raw, 'Loading songs');
    }
  }

  async getTrack(id: string): Promise<Track | null> {
    try {
      const { data, error } = await this.client
        .from('tracks')
        .select(TRACK_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Track) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Loading track');
    }
  }

  /** Newest additions, for the Home screen. */
  async getRecentlyAdded(limit = 20): Promise<Album[]> {
    try {
      const { data, error } = await this.client
        .from('albums')
        .select(ALBUM_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data as unknown as Album[]) ?? [];
    } catch (raw) {
      throw toAppError(raw, 'Loading recently added');
    }
  }

  /**
   * Recently played, de-duplicated to the most recent play per track.
   * Postgres has no DISTINCT ON through PostgREST, so we over-fetch a little
   * and collapse client-side - cheap at personal-library scale.
   */
  async getRecentlyPlayed(limit = 20): Promise<Track[]> {
    try {
      const { data, error } = await this.client
        .from('play_history')
        .select(`track_id, played_at, track:tracks ( ${TRACK_COLUMNS} )`)
        .order('played_at', { ascending: false })
        .limit(limit * 4);
      if (error) throw error;

      const seen = new Set<string>();
      const tracks: Track[] = [];
      for (const row of (data ?? []) as unknown as { track_id: string; track: Track | null }[]) {
        if (!row.track || seen.has(row.track_id)) continue;
        seen.add(row.track_id);
        tracks.push(row.track);
        if (tracks.length >= limit) break;
      }
      return tracks;
    } catch (raw) {
      // Home should still render if history is unavailable.
      const mapped = toAppError(raw, 'Loading recently played');
      if (mapped.kind === 'missing-tables') return [];
      throw mapped;
    }
  }

  /** Fire-and-forget: a failed history write must never interrupt playback. */
  async recordPlay(trackId: string): Promise<void> {
    const ownerId = connection.getOwnerId();
    if (!ownerId) return;
    try {
      await this.client.from('play_history').insert({ track_id: trackId, owner_id: ownerId });
    } catch (error) {
      console.warn('[library] could not record play', error);
    }
  }

  // -------------------------------------------------------------------------
  // Albums
  // -------------------------------------------------------------------------

  async getAlbums(params: PageParams = {}): Promise<Page<Album>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    try {
      const { data, error, count } = await this.client
        .from('albums')
        .select(ALBUM_COLUMNS, { count: 'exact' })
        .order('title', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return this.toPage<Album>(data as unknown as Album[], count, offset);
    } catch (raw) {
      throw toAppError(raw, 'Loading albums');
    }
  }

  async getAlbum(id: string): Promise<Album | null> {
    try {
      const { data, error } = await this.client
        .from('albums')
        .select(ALBUM_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Album) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Loading album');
    }
  }

  /** Album tracks in disc/track order - the order the album is meant to play. */
  async getAlbumTracks(albumId: string): Promise<Track[]> {
    try {
      const { data, error } = await this.client
        .from('tracks')
        .select(TRACK_COLUMNS)
        .eq('album_id', albumId)
        .order('disc_no', { ascending: true, nullsFirst: true })
        .order('track_no', { ascending: true, nullsFirst: true })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data as unknown as Track[]) ?? [];
    } catch (raw) {
      throw toAppError(raw, 'Loading album tracks');
    }
  }

  // -------------------------------------------------------------------------
  // Artists
  // -------------------------------------------------------------------------

  async getArtists(params: PageParams = {}): Promise<Page<Artist>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    try {
      const { data, error, count } = await this.client
        .from('artists')
        .select('*', { count: 'exact' })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return this.toPage<Artist>(data as unknown as Artist[], count, offset);
    } catch (raw) {
      throw toAppError(raw, 'Loading artists');
    }
  }

  async getArtist(id: string): Promise<Artist | null> {
    try {
      const { data, error } = await this.client
        .from('artists')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Artist) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Loading artist');
    }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    try {
      const { data, error } = await this.client
        .from('albums')
        .select(ALBUM_COLUMNS)
        .eq('artist_id', artistId)
        .order('year', { ascending: false, nullsFirst: false })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data as unknown as Album[]) ?? [];
    } catch (raw) {
      throw toAppError(raw, 'Loading artist albums');
    }
  }

  async getArtistTracks(artistId: string, limit = 100): Promise<Track[]> {
    try {
      const { data, error } = await this.client
        .from('tracks')
        .select(TRACK_COLUMNS)
        .eq('artist_id', artistId)
        .order('title', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data as unknown as Track[]) ?? [];
    } catch (raw) {
      throw toAppError(raw, 'Loading artist tracks');
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Three parallel ILIKE queries rather than one clever RPC. At personal scale
   * the trigram indexes make this fast, and it keeps search working on a plain
   * schema with no extra database functions to install.
   */
  async search(rawTerm: string, limitPerType = 20): Promise<SearchResults> {
    const term = sanitizeSearchTerm(rawTerm);
    if (term.length === 0) return { tracks: [], albums: [], artists: [] };
    const pattern = `%${term}%`;

    try {
      const [tracks, albums, artists] = await Promise.all([
        this.client
          .from('tracks')
          .select(TRACK_COLUMNS)
          .ilike('title', pattern)
          .order('title')
          .limit(limitPerType),
        this.client
          .from('albums')
          .select(ALBUM_COLUMNS)
          .ilike('title', pattern)
          .order('title')
          .limit(limitPerType),
        this.client
          .from('artists')
          .select('*')
          .ilike('name', pattern)
          .order('name')
          .limit(limitPerType),
      ]);

      const firstError = tracks.error ?? albums.error ?? artists.error;
      if (firstError) throw firstError;

      return {
        tracks: (tracks.data as unknown as Track[]) ?? [],
        albums: (albums.data as unknown as Album[]) ?? [],
        artists: (artists.data as unknown as Artist[]) ?? [],
      };
    } catch (raw) {
      throw toAppError(raw, 'Searching');
    }
  }

  // -------------------------------------------------------------------------
  // Playlists
  // -------------------------------------------------------------------------

  async getPlaylists(): Promise<Playlist[]> {
    try {
      const { data, error } = await this.client
        .from('playlists')
        .select('*, playlist_tracks(count)')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return ((data ?? []) as unknown as (Playlist & {
        playlist_tracks?: { count: number }[];
      })[]).map((row) => ({
        ...row,
        track_count: row.playlist_tracks?.[0]?.count ?? 0,
      }));
    } catch (raw) {
      throw toAppError(raw, 'Loading playlists');
    }
  }

  async getPlaylist(id: string): Promise<Playlist | null> {
    try {
      const { data, error } = await this.client
        .from('playlists')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Playlist) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Loading playlist');
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
    try {
      const { data, error } = await this.client
        .from('playlist_tracks')
        .select(`id, playlist_id, track_id, position, added_at, track:tracks ( ${TRACK_COLUMNS} )`)
        .eq('playlist_id', playlistId)
        .order('position', { ascending: true });
      if (error) throw error;
      // A track deleted out from under a playlist leaves a null join; drop it
      // rather than rendering an empty row.
      return ((data as unknown as PlaylistTrack[]) ?? []).filter((row) => row.track);
    } catch (raw) {
      throw toAppError(raw, 'Loading playlist tracks');
    }
  }

  async createPlaylist(name: string, description?: string): Promise<Playlist> {
    const ownerId = this.ownerId();
    try {
      const { data, error } = await this.client
        .from('playlists')
        .insert({ name: name.trim(), description: description?.trim() || null, owner_id: ownerId })
        .select('*')
        .single();
      if (error) throw error;
      return data as unknown as Playlist;
    } catch (raw) {
      throw toAppError(raw, 'Creating playlist');
    }
  }

  async renamePlaylist(id: string, name: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('playlists')
        .update({ name: name.trim(), updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    } catch (raw) {
      throw toAppError(raw, 'Renaming playlist');
    }
  }

  async deletePlaylist(id: string): Promise<void> {
    try {
      const { error } = await this.client.from('playlists').delete().eq('id', id);
      if (error) throw error;
    } catch (raw) {
      throw toAppError(raw, 'Deleting playlist');
    }
  }

  /** Appends after the current last position. */
  async addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    const ownerId = this.ownerId();
    try {
      const { data: last, error: lastError } = await this.client
        .from('playlist_tracks')
        .select('position')
        .eq('playlist_id', playlistId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastError) throw lastError;

      let position = (last?.position ?? 0) + 1;
      const rows = trackIds.map((track_id) => ({
        playlist_id: playlistId,
        track_id,
        owner_id: ownerId,
        position: position++,
      }));

      const { error } = await this.client.from('playlist_tracks').insert(rows);
      if (error) throw error;
    } catch (raw) {
      throw toAppError(raw, 'Adding to playlist');
    }
  }

  async removeFromPlaylist(playlistTrackId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('playlist_tracks')
        .delete()
        .eq('id', playlistTrackId);
      if (error) throw error;
    } catch (raw) {
      throw toAppError(raw, 'Removing from playlist');
    }
  }

  /**
   * Moves one entry between two neighbours using a fractional position, so a
   * reorder is a single-row UPDATE instead of renumbering the whole playlist.
   */
  async reorderPlaylistTrack(
    playlistTrackId: string,
    beforePosition: number | null,
    afterPosition: number | null,
  ): Promise<number> {
    const position = midpoint(beforePosition, afterPosition);
    try {
      const { error } = await this.client
        .from('playlist_tracks')
        .update({ position })
        .eq('id', playlistTrackId);
      if (error) throw error;
      return position;
    } catch (raw) {
      throw toAppError(raw, 'Reordering playlist');
    }
  }

  // -------------------------------------------------------------------------
  // Importing
  //
  // These back the in-app upload screen. They are deliberately small
  // find-or-create primitives rather than one big "import" query, so the
  // importer can resolve entities once and reuse them across a whole batch.
  // -------------------------------------------------------------------------

  async findArtistByName(name: string): Promise<Artist | null> {
    try {
      const { data, error } = await this.client
        .from('artists')
        .select('*')
        .eq('owner_id', this.ownerId())
        .eq('name', name)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Artist) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Looking up artist');
    }
  }

  async createArtist(name: string): Promise<Artist> {
    try {
      const { data, error } = await this.client
        .from('artists')
        .insert({ owner_id: this.ownerId(), name })
        .select('*')
        .single();
      if (error) throw error;
      return data as unknown as Artist;
    } catch (raw) {
      throw toAppError(raw, `Creating artist "${name}"`);
    }
  }

  async findAlbum(title: string, artistId: string | null): Promise<Album | null> {
    try {
      let query = this.client
        .from('albums')
        .select(ALBUM_COLUMNS)
        .eq('owner_id', this.ownerId())
        .eq('title', title);
      // A null artist_id has to be matched with `is`, not `eq`.
      query = artistId ? query.eq('artist_id', artistId) : query.is('artist_id', null);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return (data as unknown as Album) ?? null;
    } catch (raw) {
      throw toAppError(raw, 'Looking up album');
    }
  }

  async createAlbum(input: {
    title: string;
    artistId: string | null;
    year?: number | null;
    genre?: string | null;
  }): Promise<Album> {
    try {
      const { data, error } = await this.client
        .from('albums')
        .insert({
          owner_id: this.ownerId(),
          title: input.title,
          artist_id: input.artistId,
          year: input.year ?? null,
          genre: input.genre ?? null,
        })
        .select(ALBUM_COLUMNS)
        .single();
      if (error) throw error;
      return data as unknown as Album;
    } catch (raw) {
      throw toAppError(raw, `Creating album "${input.title}"`);
    }
  }

  async setAlbumCover(albumId: string, coverPath: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('albums')
        .update({ cover_path: coverPath })
        .eq('id', albumId);
      if (error) throw error;
    } catch (raw) {
      throw toAppError(raw, 'Saving album artwork');
    }
  }

  /** Used to skip files that are already in the library. */
  async trackExistsAtPath(audioPath: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('tracks')
        .select('id')
        .eq('owner_id', this.ownerId())
        .eq('audio_path', audioPath)
        .maybeSingle();
      if (error) throw error;
      return data != null;
    } catch (raw) {
      throw toAppError(raw, 'Checking for an existing track');
    }
  }

  async createTrack(input: {
    albumId: string | null;
    artistId: string | null;
    title: string;
    trackNo: number | null;
    discNo: number | null;
    durationSeconds: number | null;
    audioPath: string;
    mimeType: string | null;
    fileSize: number | null;
    genre: string | null;
    year: number | null;
  }): Promise<Track> {
    try {
      const { data, error } = await this.client
        .from('tracks')
        .insert({
          owner_id: this.ownerId(),
          album_id: input.albumId,
          artist_id: input.artistId,
          title: input.title,
          track_no: input.trackNo,
          disc_no: input.discNo,
          duration_seconds: input.durationSeconds,
          audio_path: input.audioPath,
          mime_type: input.mimeType,
          file_size: input.fileSize,
          genre: input.genre,
          year: input.year,
        })
        .select('*')
        .single();
      if (error) throw error;
      return data as unknown as Track;
    } catch (raw) {
      throw toAppError(raw, `Saving "${input.title}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  /** Preferences sync to Supabase when signed in; localStorage is the fallback. */
  async getRemotePreferences(): Promise<Record<string, unknown> | null> {
    const ownerId = connection.getOwnerId();
    if (!ownerId) return null;
    try {
      const { data, error } = await this.client
        .from('user_preferences')
        .select('data')
        .eq('owner_id', ownerId)
        .maybeSingle();
      if (error) throw error;
      return (data?.data as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  async saveRemotePreferences(data: Record<string, unknown>): Promise<void> {
    const ownerId = connection.getOwnerId();
    if (!ownerId) return;
    try {
      await this.client
        .from('user_preferences')
        .upsert({ owner_id: ownerId, data, updated_at: new Date().toISOString() });
    } catch (error) {
      console.warn('[library] could not save preferences remotely', error);
    }
  }

  // -------------------------------------------------------------------------

  async getLibraryStats(): Promise<{ tracks: number; albums: number; artists: number }> {
    try {
      const [tracks, albums, artists] = await Promise.all([
        this.client.from('tracks').select('id', { count: 'exact', head: true }),
        this.client.from('albums').select('id', { count: 'exact', head: true }),
        this.client.from('artists').select('id', { count: 'exact', head: true }),
      ]);
      return {
        tracks: tracks.count ?? 0,
        albums: albums.count ?? 0,
        artists: artists.count ?? 0,
      };
    } catch (raw) {
      throw toAppError(raw, 'Loading library stats');
    }
  }

  private toPage<T>(data: T[] | null, count: number | null, offset: number): Page<T> {
    const items = data ?? [];
    const total = count ?? offset + items.length;
    return { items, total, hasMore: offset + items.length < total };
  }
}

/** Halfway between two sparse positions; used by playlist reordering. */
export function midpoint(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1;
  if (before == null) return after! - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

export const library = new MusicLibraryService();
