/**
 * In-browser music import.
 *
 * This is the CLI importer's job done client-side. It can be, because nothing
 * about importing actually needs elevated rights: a signed-in user may insert
 * rows where `owner_id = auth.uid()` and write objects under their own
 * `<uid>/...` prefix. The service-role key the CLI needs is an artifact of
 * running outside a session, not a requirement of the task.
 *
 * Importing runs in two phases on purpose:
 *
 *   1. scan()   - read tags locally. Nothing is uploaded, so the user sees
 *                 what was detected (and any format warnings) before spending
 *                 bandwidth on it.
 *   2. run()    - resolve artists/albums once, then upload with bounded
 *                 concurrency.
 *
 * Splitting them also removes a race: if several files from one album were
 * processed in parallel, each could try to create that album.
 */

import type { ICommonTagsResult } from 'music-metadata';
import { library } from './service';
import { connection } from '../connection/manager';
import { MAX_OBJECT_BYTES, removeObject, uploadObject } from './storage';
import { AppError, toAppError } from '../utils/errors';
import { slugify } from '../utils/format';

/* -------------------------------------------------------------------------- */
/* Formats                                                                     */
/* -------------------------------------------------------------------------- */

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
};

/**
 * Safari decodes none of these. The files still import if the user insists -
 * they may be listening on Android or desktop Chrome - but saying so before
 * the upload is far kinder than a playback error afterwards.
 */
const SAFARI_CANNOT_PLAY = new Set(['.flac', '.ogg', '.oga', '.opus', '.weba']);

export const ACCEPTED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isAudioFile(file: File): boolean {
  return MIME_BY_EXTENSION[extensionOf(file.name)] !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type ImportStage =
  | 'queued'
  | 'uploading'
  | 'saving'
  | 'done'
  | 'skipped'
  | 'failed';

export interface ScannedTrack {
  /** Local id for the UI only; unrelated to any database id. */
  key: string;
  file: File;
  title: string;
  artistName: string;
  albumTitle: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  durationSeconds: number | null;
  mimeType: string;
  extension: string;
  /** Embedded cover art, if the file carried any. */
  cover: { bytes: Uint8Array; contentType: string } | null;
  /** Non-fatal note shown next to the row, e.g. a format Safari can't play. */
  warning: string | null;
}

export interface RejectedFile {
  name: string;
  reason: string;
}

export interface ScanResult {
  tracks: ScannedTrack[];
  rejected: RejectedFile[];
}

export interface AlbumGroup {
  albumTitle: string;
  artistName: string;
  tracks: ScannedTrack[];
}

export interface ImportProgress {
  key: string;
  stage: ImportStage;
  /** 0..1 within the current file, when known. */
  message?: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  failures: { title: string; reason: string }[];
  cancelled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Phase 1 - scan                                                              */
/* -------------------------------------------------------------------------- */

let parserPromise: Promise<typeof import('music-metadata')> | null = null;

/**
 * music-metadata is ~1 MB of parser. It is only ever needed on the import
 * screen, so it is loaded on demand rather than shipped in the main bundle.
 */
function loadParser(): Promise<typeof import('music-metadata')> {
  parserPromise ??= import('music-metadata');
  return parserPromise;
}

/**
 * Strips the extension and a leading track number: "03 - Salt Air.mp3" -> "Salt Air".
 *
 * A bare number is only treated as an index when it is either followed by a
 * separator ("03 - ", "03. ", "3) ") or zero-padded ("01 "). Without that
 * second condition, titles that genuinely begin with a number would be
 * mangled - "99 Luftballons" and "7 Nation Army" must survive intact.
 */
function titleFromFilename(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, '');
  const withoutIndex = withoutExtension.replace(/^\s*(?:\d{1,3}\s*[-._)]+\s*|0\d{1,2}\s+)/, '');
  return withoutIndex.trim() || withoutExtension.trim() || 'Untitled';
}

/**
 * Reads tags from the selected files. Nothing is uploaded here.
 *
 * `parseBlob` reads only the byte ranges it needs, so tagging a 60 MB file
 * does not pull 60 MB into memory.
 */
export async function scanFiles(
  files: File[],
  onProgress?: (done: number, total: number, currentName: string) => void,
): Promise<ScanResult> {
  const tracks: ScannedTrack[] = [];
  const rejected: RejectedFile[] = [];

  const candidates = files.filter((file) => {
    if (!isAudioFile(file)) {
      rejected.push({
        name: file.name,
        reason: 'Not an audio file this player recognises.',
      });
      return false;
    }
    if (file.size > MAX_OBJECT_BYTES) {
      rejected.push({
        name: file.name,
        reason: `Larger than the ${Math.round(MAX_OBJECT_BYTES / 1024 / 1024)} MB limit on the bucket.`,
      });
      return false;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: 'The file is empty.' });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return { tracks, rejected };

  const { parseBlob } = await loadParser();

  for (const [index, file] of candidates.entries()) {
    onProgress?.(index, candidates.length, file.name);

    const extension = extensionOf(file.name);
    let common: Partial<ICommonTagsResult> = {};
    let durationSeconds: number | null = null;
    let cover: ScannedTrack['cover'] = null;
    let warning: string | null = null;

    try {
      const metadata = await parseBlob(file, { duration: true });
      common = metadata.common ?? {};
      const duration = metadata.format?.duration;
      durationSeconds = typeof duration === 'number' ? Number(duration.toFixed(3)) : null;

      const picture = common.picture?.[0];
      if (picture?.data) {
        cover = {
          bytes: picture.data,
          contentType: picture.format?.includes('png') ? 'image/png' : 'image/jpeg',
        };
      }
    } catch {
      // An unreadable tag block is not fatal - the audio may still be fine.
      // Fall back to the filename and let the user fix the details later.
      warning = 'Tags could not be read; details were taken from the filename.';
    }

    if (SAFARI_CANNOT_PLAY.has(extension)) {
      const note = `Safari cannot play ${extension} files. Convert to .m4a or .mp3 to play on iPhone.`;
      warning = warning ? `${warning} ${note}` : note;
    }

    const str = (value: string | undefined): string | null => {
      const text = value?.trim() ?? '';
      return text.length > 0 ? text : null;
    };
    const num = (value: number | null | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    tracks.push({
      key: `${file.name}:${file.size}:${file.lastModified}:${index}`,
      file,
      title: str(common.title) ?? titleFromFilename(file.name),
      artistName: str(common.artist) ?? str(common.albumartist) ?? 'Unknown Artist',
      albumTitle: str(common.album) ?? 'Unknown Album',
      trackNo: num(common.track?.no),
      discNo: num(common.disk?.no) ?? 1,
      year: num(common.year),
      genre: str(common.genre?.[0]),
      durationSeconds,
      mimeType: MIME_BY_EXTENSION[extension] ?? file.type ?? 'application/octet-stream',
      extension,
      cover,
      warning,
    });
  }

  onProgress?.(candidates.length, candidates.length, '');
  return { tracks, rejected };
}

/** Groups a scan into albums for the confirmation screen. */
export function groupByAlbum(tracks: ScannedTrack[]): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();
  for (const track of tracks) {
    const key = `${track.artistName}\u0000${track.albumTitle}`;
    let group = groups.get(key);
    if (!group) {
      group = { albumTitle: track.albumTitle, artistName: track.artistName, tracks: [] };
      groups.set(key, group);
    }
    group.tracks.push(track);
  }
  for (const group of groups.values()) {
    group.tracks.sort((a, b) => (a.trackNo ?? 9999) - (b.trackNo ?? 9999));
  }
  return [...groups.values()];
}

/* -------------------------------------------------------------------------- */
/* Phase 2 - import                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Find-or-create with promise caching, so N tracks from one album produce
 * exactly one artist insert and one album insert no matter how they interleave.
 */
class EntityResolver {
  private artists = new Map<string, Promise<string>>();
  private albums = new Map<string, Promise<{ id: string; hasCover: boolean }>>();

  artistId(name: string): Promise<string> {
    const key = name.toLowerCase();
    let pending = this.artists.get(key);
    if (!pending) {
      pending = (async () => {
        const existing = await library.findArtistByName(name);
        return existing ? existing.id : (await library.createArtist(name)).id;
      })();
      this.artists.set(key, pending);
    }
    return pending;
  }

  album(
    title: string,
    artistId: string,
    year: number | null,
    genre: string | null,
  ): Promise<{ id: string; hasCover: boolean }> {
    const key = `${artistId}\u0000${title.toLowerCase()}`;
    let pending = this.albums.get(key);
    if (!pending) {
      pending = (async () => {
        const existing = await library.findAlbum(title, artistId);
        if (existing) return { id: existing.id, hasCover: Boolean(existing.cover_path) };
        const created = await library.createAlbum({ title, artistId, year, genre });
        return { id: created.id, hasCover: false };
      })();
      this.albums.set(key, pending);
    }
    return pending;
  }
}

/** Object key for a track, matching the layout the Storage policy enforces. */
export function audioPathFor(
  ownerId: string,
  albumId: string,
  track: { trackNo: number | null; title: string; extension: string },
  fallbackIndex: number,
): string {
  const index = String(track.trackNo ?? fallbackIndex).padStart(2, '0');
  return `${ownerId}/albums/${albumId}/${index}-${slugify(track.title)}${track.extension}`;
}

export interface ImportOptions {
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
  /** Parallel uploads. Kept low: this often runs on a phone. */
  concurrency?: number;
}

/**
 * Uploads each track and writes its row.
 *
 * Per file the order is: upload bytes, then insert the row. If the insert
 * fails the uploaded object is removed again, so a failed import cannot leave
 * orphaned audio sitting in the bucket.
 */
export async function importTracks(
  tracks: ScannedTrack[],
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    imported: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    cancelled: false,
  };
  if (tracks.length === 0) return summary;

  const ownerId = connection.getOwnerId();
  if (!ownerId) {
    throw new AppError('auth-required', 'Sign in before adding music.', {
      hint: 'Your library is protected by Row Level Security, so uploads need a signed-in user.',
    });
  }

  const resolver = new EntityResolver();
  const coversDone = new Set<string>();
  const queue = [...tracks.entries()];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));

  const report = (key: string, stage: ImportStage, message?: string) =>
    options.onProgress?.({ key, stage, message });

  const worker = async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const next = queue.shift();
      if (!next) return;
      const [index, track] = next;

      let uploadedPath: string | null = null;
      try {
        const artistId = await resolver.artistId(track.artistName);
        const album = await resolver.album(
          track.albumTitle,
          artistId,
          track.year,
          track.genre,
        );

        const audioPath = audioPathFor(ownerId, album.id, track, index + 1);

        if (await library.trackExistsAtPath(audioPath)) {
          summary.skipped++;
          report(track.key, 'skipped', 'Already in your library');
          continue;
        }

        if (options.signal?.aborted) return;

        report(track.key, 'uploading');
        await uploadObject(audioPath, track.file, {
          contentType: track.mimeType,
          signal: options.signal,
        });
        uploadedPath = audioPath;

        report(track.key, 'saving');
        await library.createTrack({
          albumId: album.id,
          artistId,
          title: track.title,
          trackNo: track.trackNo,
          discNo: track.discNo,
          durationSeconds: track.durationSeconds,
          audioPath,
          mimeType: track.mimeType,
          fileSize: track.file.size,
          genre: track.genre,
          year: track.year,
        });
        uploadedPath = null; // committed; no longer ours to roll back

        // First track of an album that carries artwork supplies the cover.
        if (track.cover && !album.hasCover && !coversDone.has(album.id)) {
          coversDone.add(album.id);
          try {
            const extension = track.cover.contentType === 'image/png' ? '.png' : '.jpg';
            const coverPath = `${ownerId}/albums/${album.id}/cover${extension}`;
            await uploadObject(coverPath, track.cover.bytes, {
              contentType: track.cover.contentType,
              upsert: true,
            });
            await library.setAlbumCover(album.id, coverPath);
          } catch (error) {
            // Artwork is a nice-to-have; never fail a track over it.
            console.warn('[import] could not store album artwork', error);
          }
        }

        summary.imported++;
        report(track.key, 'done');
      } catch (raw) {
        if (uploadedPath) await removeObject(uploadedPath);
        const error = toAppError(raw);
        summary.failed++;
        summary.failures.push({ title: track.title, reason: error.userMessage });
        report(track.key, 'failed', error.userMessage);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  summary.cancelled = options.signal?.aborted === true;
  return summary;
}
