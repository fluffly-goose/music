import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A chainable stand-in for PostgREST's query builder. Each call records itself
 * and returns `this`, so we can assert on the query the service actually built
 * and hand back canned rows.
 */
interface QueryLog { table: string; ops: [string, ...unknown[]][] }

let queries: QueryLog[] = [];
let responder: (q: QueryLog) => { data: unknown; error: unknown; count?: number } =
  () => ({ data: [], error: null, count: 0 });

function makeBuilder(table: string) {
  const log: QueryLog = { table, ops: [] };
  queries.push(log);

  const builder: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => {
    log.ops.push([name, ...args]);
    return builder;
  };
  for (const m of ['select','insert','update','upsert','delete','eq','ilike','order','range','limit','or']) {
    builder[m] = chain(m);
  }
  const settle = () => {
    const r = responder(log);
    return Promise.resolve({ data: r.data, error: r.error, count: r.count ?? null });
  };
  builder.maybeSingle = () => { log.ops.push(['maybeSingle']); return settle(); };
  builder.single = () => { log.ops.push(['single']); return settle(); };
  builder.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
  return builder;
}

const ownerId = 'owner-1';
vi.mock('@/lib/connection/manager', () => ({
  connection: {
    requireClient: () => ({ from: (table: string) => makeBuilder(table) }),
    getClient: () => ({ from: (table: string) => makeBuilder(table) }),
    getBucket: () => 'music',
    getOwnerId: () => ownerId,
  },
}));

const { library } = await import('@/lib/library/service');

const trackRow = {
  id: 't1', album_id: 'a1', artist_id: 'ar1', title: 'Song One',
  track_no: 1, disc_no: 1, duration_seconds: 210, audio_path: 'owner-1/albums/a1/01.mp3',
  mime_type: 'audio/mpeg', file_size: 1, genre: null, year: 2024, created_at: '2024-01-01',
  album: { id: 'a1', title: 'Album', cover_path: 'owner-1/albums/a1/cover.jpg', year: 2024 },
  artist: { id: 'ar1', name: 'Artist' },
};

beforeEach(() => {
  queries = [];
  responder = () => ({ data: [], error: null, count: 0 });
});

describe('catalog retrieval', () => {
  it('pages through songs and reports whether more remain', async () => {
    responder = () => ({ data: [trackRow], error: null, count: 120 });
    const page = await library.getTracks({ offset: 0, limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(120);
    expect(page.hasMore).toBe(true);

    const q = queries[0]!;
    expect(q.table).toBe('tracks');
    expect(q.ops.find((o) => o[0] === 'range')).toEqual(['range', 0, 49]);
  });

  it('reports hasMore false on the last page', async () => {
    responder = () => ({ data: [trackRow], error: null, count: 1 });
    expect((await library.getTracks()).hasMore).toBe(false);
  });

  it('requests album tracks in disc then track order', async () => {
    responder = () => ({ data: [trackRow], error: null });
    await library.getAlbumTracks('a1');
    const orders = queries[0]!.ops.filter((o) => o[0] === 'order').map((o) => o[1]);
    expect(orders).toEqual(['disc_no', 'track_no', 'title']);
  });

  it('fetches a single album by id', async () => {
    responder = () => ({ data: { id: 'a1', title: 'Album' }, error: null });
    const album = await library.getAlbum('a1');
    expect(album?.id).toBe('a1');
    expect(queries[0]!.ops).toContainEqual(['eq', 'id', 'a1']);
  });

  it('returns null for an album that does not exist', async () => {
    responder = () => ({ data: null, error: null });
    expect(await library.getAlbum('nope')).toBeNull();
  });

  it('orders artist albums newest first', async () => {
    responder = () => ({ data: [], error: null });
    await library.getArtistAlbums('ar1');
    expect(queries[0]!.ops).toContainEqual(['order', 'year', { ascending: false, nullsFirst: false }]);
  });

  it('counts the whole library for the Settings screen', async () => {
    responder = () => ({ data: [], error: null, count: 7 });
    expect(await library.getLibraryStats()).toEqual({ tracks: 7, albums: 7, artists: 7 });
  });
});

describe('recently played', () => {
  it('de-duplicates repeats, keeping the most recent play', async () => {
    responder = () => ({
      data: [
        { track_id: 't1', played_at: '2024-03-03', track: trackRow },
        { track_id: 't1', played_at: '2024-03-02', track: trackRow },
        { track_id: 't2', played_at: '2024-03-01', track: { ...trackRow, id: 't2' } },
      ],
      error: null,
    });
    const recent = await library.getRecentlyPlayed(10);
    expect(recent.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('degrades to empty rather than breaking Home when history is missing', async () => {
    responder = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    expect(await library.getRecentlyPlayed()).toEqual([]);
  });

  it('never lets a failed history write bubble into playback', async () => {
    responder = () => ({ data: null, error: { message: 'insert failed' } });
    await expect(library.recordPlay('t1')).resolves.toBeUndefined();
  });
});

describe('search', () => {
  it('queries tracks, albums and artists in parallel', async () => {
    responder = (q) => ({ data: q.table === 'tracks' ? [trackRow] : [], error: null });
    const results = await library.search('song');
    expect(results.tracks).toHaveLength(1);
    expect(queries.map((q) => q.table).sort()).toEqual(['albums', 'artists', 'tracks']);
  });

  it('wraps the term in wildcards for a substring match', async () => {
    responder = () => ({ data: [], error: null });
    await library.search('blue');
    expect(queries[0]!.ops).toContainEqual(['ilike', 'title', '%blue%']);
  });

  it('strips characters that would break a PostgREST filter', async () => {
    responder = () => ({ data: [], error: null });
    await library.search('rock,pop(x)');
    const ilike = queries[0]!.ops.find((o) => o[0] === 'ilike')!;
    expect(ilike[2]).toBe('%rock pop x%');
  });

  it('short-circuits an empty search without hitting the network', async () => {
    const results = await library.search('   ');
    expect(results).toEqual({ tracks: [], albums: [], artists: [] });
    expect(queries).toHaveLength(0);
  });
});

describe('playlists', () => {
  it('lists playlists with a track count', async () => {
    responder = () => ({
      data: [{ id: 'p1', name: 'Mix', created_at: '', updated_at: '', description: null, cover_path: null, playlist_tracks: [{ count: 12 }] }],
      error: null,
    });
    const playlists = await library.getPlaylists();
    expect(playlists[0]!.track_count).toBe(12);
  });

  it('stamps new playlists with the signed-in owner', async () => {
    responder = () => ({ data: { id: 'p1', name: 'New' }, error: null });
    await library.createPlaylist('  New  ');
    const insert = queries[0]!.ops.find((o) => o[0] === 'insert')!;
    expect(insert[1]).toMatchObject({ name: 'New', owner_id: ownerId });
  });

  it('appends after the current last position', async () => {
    responder = (q) => q.ops.some((o) => o[0] === 'maybeSingle')
      ? { data: { position: 9 }, error: null }
      : { data: null, error: null };
    await library.addTracksToPlaylist('p1', ['t1', 't2']);
    const insert = queries.at(-1)!.ops.find((o) => o[0] === 'insert')!;
    expect(insert[1]).toEqual([
      { playlist_id: 'p1', track_id: 't1', owner_id: ownerId, position: 10 },
      { playlist_id: 'p1', track_id: 't2', owner_id: ownerId, position: 11 },
    ]);
  });

  it('adding nothing is a no-op', async () => {
    await library.addTracksToPlaylist('p1', []);
    expect(queries).toHaveLength(0);
  });

  it('reorders with a single fractional-position update', async () => {
    responder = () => ({ data: null, error: null });
    const position = await library.reorderPlaylistTrack('pt1', 2, 3);
    expect(position).toBe(2.5);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.ops).toContainEqual(['update', { position: 2.5 }]);
  });

  it('drops rows whose track was deleted underneath the playlist', async () => {
    responder = () => ({
      data: [
        { id: 'pt1', playlist_id: 'p1', track_id: 't1', position: 1, added_at: '', track: trackRow },
        { id: 'pt2', playlist_id: 'p1', track_id: 'gone', position: 2, added_at: '', track: null },
      ],
      error: null,
    });
    expect(await library.getPlaylistTracks('p1')).toHaveLength(1);
  });

  it('refuses to mutate a playlist when signed out', async () => {
    vi.resetModules();
    vi.doMock('@/lib/connection/manager', () => ({
      connection: {
        requireClient: () => ({ from: (t: string) => makeBuilder(t) }),
        getBucket: () => 'music',
        getOwnerId: () => null,
      },
    }));
    const { library: signedOut } = await import('@/lib/library/service');
    await expect(signedOut.createPlaylist('X')).rejects.toMatchObject({ kind: 'auth-required' });
    vi.doUnmock('@/lib/connection/manager');
  });
});

describe('editing', () => {
  it('patches only the fields a form touched', async () => {
    responder = () => ({ data: null, error: null });
    await library.updateTrack('t1', { title: 'New Title', track_no: 3 });
    const update = queries[0]!.ops.find((o) => o[0] === 'update')!;
    expect(update[1]).toEqual({ title: 'New Title', track_no: 3 });
    expect(queries[0]!.ops).toContainEqual(['eq', 'id', 't1']);
  });

  it('can clear a field by patching it to null', async () => {
    responder = () => ({ data: null, error: null });
    await library.updateTrack('t1', { genre: null, year: null });
    const update = queries[0]!.ops.find((o) => o[0] === 'update')!;
    expect(update[1]).toEqual({ genre: null, year: null });
  });

  it('moves an album to a different artist', async () => {
    responder = () => ({ data: null, error: null });
    await library.updateAlbum('a1', { artist_id: 'ar9' });
    expect(queries[0]!.ops.find((o) => o[0] === 'update')![1]).toEqual({ artist_id: 'ar9' });
  });

  it('names a duplicate artist clash rather than failing generically', async () => {
    // The schema has unique (owner_id, name), so this is a real outcome.
    responder = () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
    await expect(library.updateArtist('ar1', { name: 'Taken' })).rejects.toMatchObject({
      userMessage: expect.stringMatching(/already have an artist with that name/i),
    });
  });

  it('collects a track audio path before deleting, so the file can be cleaned up', async () => {
    responder = () => ({ data: { audio_path: 'owner/albums/a1/01-x.mp3' }, error: null });
    expect(await library.getTrackAudioPath('t1')).toBe('owner/albums/a1/01-x.mp3');
  });

  it('collects every audio path in an album', async () => {
    responder = () => ({ data: [{ audio_path: 'p1' }, { audio_path: 'p2' }], error: null });
    expect(await library.getAlbumAudioPaths('a1')).toEqual(['p1', 'p2']);
  });

  it('deletes a track by id', async () => {
    responder = () => ({ data: null, error: null });
    await library.deleteTrack('t1');
    expect(queries[0]!.ops).toContainEqual(['delete']);
    expect(queries[0]!.ops).toContainEqual(['eq', 'id', 't1']);
  });

  it('reports how much an artist rename will affect', async () => {
    responder = (q) => ({ data: [], error: null, count: q.table === 'albums' ? 2 : 9 });
    expect(await library.getArtistUsage('ar1')).toEqual({ albums: 2, tracks: 9 });
  });

  it('moves a single song to a different artist and album', async () => {
    responder = () => ({ data: null, error: null });
    await library.updateTrack('t1', { artist_id: 'ar9', album_id: 'al9' });
    expect(queries[0]!.ops.find((o) => o[0] === 'update')![1]).toEqual({
      artist_id: 'ar9', album_id: 'al9',
    });
    expect(queries[0]!.ops).toContainEqual(['eq', 'id', 't1']);
  });

  it('re-points a whole album\'s songs at one artist in a single update', async () => {
    // tracks.artist_id is independent of albums.artist_id, so changing an
    // album's artist without this leaves every song under the old one.
    responder = () => ({ data: null, error: null });
    await library.setAlbumTracksArtist('al1', 'ar9');
    expect(queries[0]!.table).toBe('tracks');
    expect(queries[0]!.ops).toContainEqual(['update', { artist_id: 'ar9' }]);
    expect(queries[0]!.ops).toContainEqual(['eq', 'album_id', 'al1']);
    expect(queries).toHaveLength(1);
  });

  it('can clear an album\'s songs of any artist', async () => {
    responder = () => ({ data: null, error: null });
    await library.setAlbumTracksArtist('al1', null);
    expect(queries[0]!.ops).toContainEqual(['update', { artist_id: null }]);
  });

  it('counts an album\'s songs, to detect one left empty by a move', async () => {
    responder = () => ({ data: [], error: null, count: 0 });
    expect(await library.getAlbumTrackCount('al1')).toBe(0);
  });

  it('assumes an album is not empty when the count cannot be read', async () => {
    // Guessing "empty" here would delete an album on a transient failure.
    responder = () => ({ data: null, error: { message: 'network' } });
    expect(await library.getAlbumTrackCount('al1')).toBe(1);
  });

  it('deletes an artist by id', async () => {
    responder = () => ({ data: null, error: null });
    await library.deleteArtist('ar1');
    expect(queries[0]!.table).toBe('artists');
    expect(queries[0]!.ops).toContainEqual(['delete']);
  });

  it('surfaces an RLS refusal when editing someone else\'s row', async () => {
    responder = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(library.updateAlbum('a1', { title: 'x' })).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('error surfacing', () => {
  it('turns a missing table into actionable setup advice', async () => {
    responder = () => ({ data: null, error: { code: '42P01', message: 'relation "tracks" does not exist' } });
    await expect(library.getTracks()).rejects.toMatchObject({ kind: 'missing-tables' });
  });

  it('turns an RLS refusal into a forbidden error', async () => {
    responder = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(library.getAlbums()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('surfaces a failure from any one of the parallel search queries', async () => {
    responder = (q) => q.table === 'artists'
      ? { data: null, error: { message: 'boom' } }
      : { data: [], error: null };
    await expect(library.search('x')).rejects.toThrow();
  });
});
