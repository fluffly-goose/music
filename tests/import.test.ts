import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The importer's collaborators are mocked so these tests cover the import
 * logic itself: entity de-duplication, path construction, skipping, rollback
 * and concurrency.
 */
const uploadObject = vi.fn(async (path: string) => path);
const removeObject = vi.fn(async () => {});

const findArtistByName = vi.fn(async (_name: string) => null as { id: string } | null);
const createArtist = vi.fn(async (name: string) => ({ id: `artist-${name}` }));
const findAlbum = vi.fn(async (_t: string, _a: string | null) => null as { id: string; cover_path: string | null } | null);
const createAlbum = vi.fn(async (input: { title: string }) => ({ id: `album-${input.title}`, cover_path: null }));
const trackExistsAtPath = vi.fn(async (_p: string) => false);
const createTrack = vi.fn(async (input: { title: string }) => ({ id: `track-${input.title}` }));
const setAlbumCover = vi.fn(async () => {});

let ownerId: string | null = 'owner-1';

vi.mock('@/lib/connection/manager', () => ({
  connection: {
    getOwnerId: () => ownerId,
    requireClient: () => ({}),
    getClient: () => ({}),
    getBucket: () => 'music',
  },
}));

vi.mock('@/lib/library/service', () => ({
  library: {
    findArtistByName: (...a: unknown[]) => findArtistByName(...(a as [string])),
    createArtist: (...a: unknown[]) => createArtist(...(a as [string])),
    findAlbum: (...a: unknown[]) => findAlbum(...(a as [string, string | null])),
    createAlbum: (...a: unknown[]) => createAlbum(...(a as [{ title: string }])),
    trackExistsAtPath: (...a: unknown[]) => trackExistsAtPath(...(a as [string])),
    createTrack: (...a: unknown[]) => createTrack(...(a as [{ title: string }])),
    setAlbumCover: (...a: unknown[]) => setAlbumCover(...(a as [])),
  },
}));

vi.mock('@/lib/library/storage', () => ({
  MAX_OBJECT_BYTES: 200 * 1024 * 1024,
  uploadObject: (...a: unknown[]) => uploadObject(...(a as [string])),
  removeObject: (...a: unknown[]) => removeObject(...(a as [])),
}));

const { importTracks, audioPathFor, groupByAlbum, extensionOf, isAudioFile } =
  await import('@/lib/library/import');
import type { ScannedTrack } from '@/lib/library/import';

function makeTrack(over: Partial<ScannedTrack> = {}): ScannedTrack {
  const title = over.title ?? 'Salt Air';
  return {
    key: over.key ?? `key-${title}`,
    file: new File([new Uint8Array(1024)], `${title}.mp3`, { type: 'audio/mpeg' }),
    title,
    artistName: 'Aurora Field',
    albumTitle: 'Slow Tide',
    trackNo: 3,
    discNo: 1,
    year: 2023,
    genre: 'Ambient',
    durationSeconds: 196.5,
    mimeType: 'audio/mpeg',
    extension: '.mp3',
    cover: null,
    warning: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerId = 'owner-1';
  findArtistByName.mockResolvedValue(null);
  findAlbum.mockResolvedValue(null);
  trackExistsAtPath.mockResolvedValue(false);
  createArtist.mockImplementation(async (name: string) => ({ id: `artist-${name}` }));
  createAlbum.mockImplementation(async (input: { title: string }) => ({ id: `album-${input.title}`, cover_path: null }));
  uploadObject.mockImplementation(async (path: string) => path);
});

describe('file classification', () => {
  it('extracts extensions case-insensitively', () => {
    expect(extensionOf('Song.MP3')).toBe('.mp3');
    expect(extensionOf('no-extension')).toBe('');
  });

  it('accepts formats the player can stream', () => {
    for (const name of ['a.mp3', 'a.m4a', 'a.wav', 'a.aiff', 'a.flac']) {
      expect(isAudioFile(new File([], name))).toBe(true);
    }
  });

  it('rejects non-audio files', () => {
    for (const name of ['cover.jpg', 'notes.txt', 'album.zip']) {
      expect(isAudioFile(new File([], name))).toBe(false);
    }
  });
});

describe('storage paths', () => {
  it('puts the owner id first, which is what the Storage policy matches on', () => {
    const path = audioPathFor('owner-1', 'album-9', { trackNo: 3, title: 'Salt Air', extension: '.mp3' }, 1);
    expect(path.split('/')[0]).toBe('owner-1');
    expect(path).toBe('owner-1/albums/album-9/03-salt-air.mp3');
  });

  it('zero-pads the track number and slugifies the title', () => {
    const path = audioPathFor('o', 'a', { trackNo: 7, title: 'Björk — Jóga (Live!)', extension: '.m4a' }, 1);
    expect(path).toBe('o/albums/a/07-bjork-joga-live.m4a');
  });

  it('falls back to position when the file has no track number', () => {
    const path = audioPathFor('o', 'a', { trackNo: null, title: 'X', extension: '.mp3' }, 4);
    expect(path).toBe('o/albums/a/04-x.mp3');
  });
});

describe('grouping for the review screen', () => {
  it('groups by album and orders by track number', () => {
    const groups = groupByAlbum([
      makeTrack({ key: 'b', title: 'B', trackNo: 2 }),
      makeTrack({ key: 'a', title: 'A', trackNo: 1 }),
      makeTrack({ key: 'c', title: 'C', albumTitle: 'Night Ferry', trackNo: 1 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.tracks.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('keeps same-titled albums by different artists apart', () => {
    const groups = groupByAlbum([
      makeTrack({ key: '1', artistName: 'One' }),
      makeTrack({ key: '2', artistName: 'Two' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('importing', () => {
  it('uploads the file and writes the row', async () => {
    const summary = await importTracks([makeTrack()]);
    expect(summary).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    expect(uploadObject).toHaveBeenCalledWith(
      'owner-1/albums/album-Slow Tide/03-salt-air.mp3',
      expect.anything(),
      expect.objectContaining({ contentType: 'audio/mpeg' }),
    );
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Salt Air', trackNo: 3, durationSeconds: 196.5, fileSize: 1024,
    }));
  });

  it('creates each artist and album exactly once for a whole album', async () => {
    const tracks = ['One', 'Two', 'Three', 'Four'].map((t, i) =>
      makeTrack({ key: `k${i}`, title: t, trackNo: i + 1 }));
    const summary = await importTracks(tracks, { concurrency: 4 });

    expect(summary.imported).toBe(4);
    // The race this guards against: four parallel workers each creating the album.
    expect(createArtist).toHaveBeenCalledTimes(1);
    expect(createAlbum).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing artist and album instead of duplicating them', async () => {
    findArtistByName.mockResolvedValue({ id: 'existing-artist' });
    findAlbum.mockResolvedValue({ id: 'existing-album', cover_path: null });

    await importTracks([makeTrack()]);
    expect(createArtist).not.toHaveBeenCalled();
    expect(createAlbum).not.toHaveBeenCalled();
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({
      albumId: 'existing-album', artistId: 'existing-artist',
    }));
  });

  it('skips a track already stored at the same path', async () => {
    trackExistsAtPath.mockResolvedValue(true);
    const summary = await importTracks([makeTrack()]);
    expect(summary).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it('re-running an import is safe', async () => {
    const tracks = [makeTrack({ key: 'a', title: 'A' }), makeTrack({ key: 'b', title: 'B' })];
    await importTracks(tracks);
    trackExistsAtPath.mockResolvedValue(true);
    const second = await importTracks(tracks);
    expect(second).toMatchObject({ imported: 0, skipped: 2, failed: 0 });
  });

  it('deletes the uploaded file when the row cannot be written', async () => {
    // Otherwise a failed import leaves orphaned audio in the bucket forever.
    createTrack.mockRejectedValueOnce(new Error('insert blocked by RLS'));
    const summary = await importTracks([makeTrack()]);

    expect(summary.failed).toBe(1);
    expect(removeObject).toHaveBeenCalledWith('owner-1/albums/album-Slow Tide/03-salt-air.mp3');
  });

  it('does not delete anything when the upload itself failed', async () => {
    uploadObject.mockRejectedValueOnce(new Error('network died'));
    const summary = await importTracks([makeTrack()]);
    expect(summary.failed).toBe(1);
    expect(removeObject).not.toHaveBeenCalled();
  });

  it('keeps going after one file fails, and reports it', async () => {
    uploadObject
      .mockImplementationOnce(async () => { throw new Error('boom'); })
      .mockImplementation(async (path: string) => path);

    const summary = await importTracks(
      [makeTrack({ key: 'a', title: 'A' }), makeTrack({ key: 'b', title: 'B' })],
      { concurrency: 1 },
    );
    expect(summary.imported).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]).toMatchObject({ title: 'A' });
  });

  it('stores embedded artwork once per album', async () => {
    const cover = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' };
    await importTracks(
      [makeTrack({ key: 'a', title: 'A', cover }), makeTrack({ key: 'b', title: 'B', cover })],
      { concurrency: 1 },
    );
    const coverUploads = uploadObject.mock.calls.filter(([p]) => String(p).includes('/cover'));
    expect(coverUploads).toHaveLength(1);
    expect(setAlbumCover).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite artwork an album already has', async () => {
    findAlbum.mockResolvedValue({ id: 'existing-album', cover_path: 'owner-1/albums/existing-album/cover.jpg' });
    await importTracks([makeTrack({ cover: { bytes: new Uint8Array([1]), contentType: 'image/jpeg' } })]);
    expect(setAlbumCover).not.toHaveBeenCalled();
  });

  it('never fails a track just because its artwork could not be stored', async () => {
    uploadObject.mockImplementation(async (path: string) => {
      if (String(path).includes('/cover')) throw new Error('artwork rejected');
      return path;
    });
    const summary = await importTracks([
      makeTrack({ cover: { bytes: new Uint8Array([1]), contentType: 'image/jpeg' } }),
    ]);
    expect(summary).toMatchObject({ imported: 1, failed: 0 });
  });

  it('reports progress for every file', async () => {
    const stages: string[] = [];
    await importTracks([makeTrack()], { onProgress: (p) => stages.push(p.stage) });
    expect(stages).toContain('uploading');
    expect(stages).toContain('saving');
    expect(stages).toContain('done');
  });

  it('refuses to import when signed out', async () => {
    ownerId = null;
    await expect(importTracks([makeTrack()])).rejects.toMatchObject({ kind: 'auth-required' });
  });

  it('importing nothing is a no-op', async () => {
    const summary = await importTracks([]);
    expect(summary).toMatchObject({ imported: 0, skipped: 0, failed: 0 });
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it('stops early when cancelled', async () => {
    const controller = new AbortController();
    uploadObject.mockImplementation(async (path: string) => {
      controller.abort();
      return path;
    });
    const many = Array.from({ length: 8 }, (_, i) => makeTrack({ key: `k${i}`, title: `T${i}` }));
    const summary = await importTracks(many, { signal: controller.signal, concurrency: 1 });

    expect(summary.cancelled).toBe(true);
    expect(summary.imported).toBeLessThan(many.length);
  });
});
