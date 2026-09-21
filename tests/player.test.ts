import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Track } from '@/lib/library/types';

// ---------------------------------------------------------------------------
// The engine's collaborators are mocked so these tests exercise playback state
// transitions only - no network, no real Supabase client.
// ---------------------------------------------------------------------------
const signMock = vi.fn(async (_c: unknown, _b: string, path: string) => `https://cdn.test/${path}`);
const invalidateMock = vi.fn();
const recordPlayMock = vi.fn(async () => {});

vi.mock('@/lib/connection/manager', () => ({
  connection: {
    requireClient: () => ({}),
    getClient: () => ({}),
    getBucket: () => 'music',
    getOwnerId: () => 'owner-1',
  },
}));

vi.mock('@/lib/library/service', () => ({
  library: { recordPlay: (...args: unknown[]) => recordPlayMock(...(args as [])) },
}));

vi.mock('@/lib/library/artwork', () => ({
  artworkUrl: async () => 'https://cdn.test/cover.jpg',
}));

vi.mock('@/lib/player/urls', () => ({
  signedUrls: {
    get: (...args: unknown[]) => signMock(...(args as [unknown, string, string])),
    invalidate: (...args: unknown[]) => invalidateMock(...(args as [])),
    peek: () => null,
    clear: () => {},
  },
  DEFAULT_TTL_SECONDS: 3600,
}));

const { PlaybackEngine } = await import('@/lib/player/engine');

function makeTrack(id: string): Track {
  return {
    id, album_id: 'album-1', artist_id: 'artist-1', title: `Song ${id}`,
    track_no: Number(id), disc_no: 1, duration_seconds: 200,
    audio_path: `owner-1/albums/album-1/${id}.mp3`, mime_type: 'audio/mpeg',
    file_size: 5_000_000, genre: 'Test', year: 2024, created_at: '2024-01-01T00:00:00Z',
    album: { id: 'album-1', title: 'Test Album', cover_path: 'owner-1/albums/album-1/cover.jpg', year: 2024 },
    artist: { id: 'artist-1', name: 'Test Artist' },
  };
}

const tracks = ['1', '2', '3'].map(makeTrack);

/**
 * jsdom has no media pipeline, so play()/load() are stubbed and the events a
 * real browser would emit are dispatched by hand.
 */
function makeAudio(): HTMLAudioElement {
  const audio = document.createElement('audio');
  let playing = false;
  Object.defineProperty(audio, 'play', {
    value: vi.fn(async () => { playing = true; audio.dispatchEvent(new Event('playing')); }),
  });
  Object.defineProperty(audio, 'pause', {
    value: vi.fn(() => { playing = false; audio.dispatchEvent(new Event('pause')); }),
  });
  Object.defineProperty(audio, 'load', { value: vi.fn() });
  Object.defineProperty(audio, 'paused', { get: () => !playing });
  let time = 0;
  Object.defineProperty(audio, 'currentTime', {
    get: () => time, set: (v: number) => { time = v; }, configurable: true,
  });
  Object.defineProperty(audio, 'duration', { get: () => 200, configurable: true });
  return audio;
}

describe('playback engine', () => {
  let engine: InstanceType<typeof PlaybackEngine>;
  let audio: HTMLAudioElement;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    engine = new PlaybackEngine();
    audio = makeAudio();
    engine.attach(audio);
  });

  it('starts idle with nothing loaded', () => {
    expect(engine.store.get().status).toBe('idle');
    expect(engine.store.get().track).toBeNull();
  });

  it('loads a queue, signs the audio path, and starts playing', async () => {
    await engine.playTracks(tracks, { startIndex: 0 });
    expect(signMock).toHaveBeenCalledWith(expect.anything(), 'music', tracks[0]!.audio_path);
    expect(engine.store.get().track?.id).toBe('1');
    expect(engine.store.get().status).toBe('playing');
  });

  it('starts at a chosen track when a row is tapped', async () => {
    await engine.playTracks(tracks, { startIndex: 2 });
    expect(engine.store.get().track?.id).toBe('3');
  });

  it('ignores a request to play an empty list', async () => {
    await engine.playTracks([]);
    expect(engine.store.get().status).toBe('idle');
  });

  it('pauses and resumes', async () => {
    await engine.playTracks(tracks);
    engine.pause();
    expect(engine.store.get().status).toBe('paused');
    await engine.play();
    expect(engine.store.get().status).toBe('playing');
  });

  it('toggle flips between playing and paused', async () => {
    await engine.playTracks(tracks);
    await engine.toggle();
    expect(engine.store.get().status).toBe('paused');
    await engine.toggle();
    expect(engine.store.get().status).toBe('playing');
  });

  it('advances to the next track', async () => {
    await engine.playTracks(tracks, { startIndex: 0 });
    await engine.next();
    expect(engine.store.get().track?.id).toBe('2');
    expect(engine.store.get().status).toBe('playing');
  });

  it('stops cleanly at the end of the queue instead of erroring', async () => {
    await engine.playTracks(tracks, { startIndex: 2 });
    await engine.next();
    expect(engine.store.get().status).toBe('paused');
    expect(engine.store.get().error).toBeNull();
  });

  it('auto-advances when a track ends', async () => {
    await engine.playTracks(tracks, { startIndex: 0 });
    audio.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(engine.store.get().track?.id).toBe('2'));
  });

  it('repeat-one replays the same track on natural end', async () => {
    await engine.playTracks(tracks, { startIndex: 1 });
    engine.setRepeat('one');
    await engine.next({ auto: true });
    expect(engine.store.get().track?.id).toBe('2');
  });

  it('previous restarts the track when pressed after a few seconds', async () => {
    await engine.playTracks(tracks, { startIndex: 1 });
    audio.currentTime = 30;
    audio.dispatchEvent(new Event('timeupdate'));
    await engine.previous();
    expect(engine.store.get().track?.id).toBe('2');  // same track
    expect(audio.currentTime).toBe(0);               // rewound
  });

  it('previous steps back when pressed at the very start', async () => {
    await engine.playTracks(tracks, { startIndex: 1 });
    await engine.previous();
    expect(engine.store.get().track?.id).toBe('1');
  });

  it('switching tracks reuses the same audio element', async () => {
    // Creating a new element would lose iOS's user-gesture permission.
    await engine.playTracks(tracks, { startIndex: 0 });
    await engine.next();
    expect(engine.store.get().track?.id).toBe('2');
    expect(document.querySelectorAll('audio')).toHaveLength(0); // never appended extras
  });

  it('tracks position from timeupdate events', async () => {
    await engine.playTracks(tracks);
    audio.currentTime = 42;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(engine.store.get().currentTime).toBe(42);
  });

  it('ignores timeupdate while the user is scrubbing', async () => {
    await engine.playTracks(tracks);
    engine.setSeeking(true);
    audio.currentTime = 99;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(engine.store.get().currentTime).not.toBe(99);
  });

  it('reads duration from loadedmetadata', async () => {
    await engine.playTracks(tracks);
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(engine.store.get().duration).toBe(200);
  });

  it('clamps a seek beyond the end of the track', async () => {
    await engine.playTracks(tracks);
    audio.dispatchEvent(new Event('loadedmetadata'));
    engine.seek(9999);
    expect(engine.store.get().currentTime).toBe(200);
    engine.seek(-50);
    expect(engine.store.get().currentTime).toBe(0);
  });

  it('clamps and persists volume', async () => {
    engine.setVolume(0.5);
    expect(engine.store.get().volume).toBe(0.5);
    expect(audio.volume).toBe(0.5);
    engine.setVolume(3);
    expect(engine.store.get().volume).toBe(1);
  });

  it('records a play only once the listener is committed to the track', async () => {
    await engine.playTracks(tracks);
    audio.currentTime = 2;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(recordPlayMock).not.toHaveBeenCalled();

    audio.currentTime = 30;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(recordPlayMock).toHaveBeenCalledWith('1');

    // and not repeatedly for the same track
    audio.currentTime = 60;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(recordPlayMock).toHaveBeenCalledTimes(1);
  });

  it('re-signs the URL and resumes in place when audio fails mid-track', async () => {
    await engine.playTracks(tracks, { startIndex: 0 });
    audio.currentTime = 75;
    audio.dispatchEvent(new Event('timeupdate'));

    signMock.mockClear();
    audio.dispatchEvent(new Event('error'));

    await vi.waitFor(() => expect(invalidateMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(signMock).toHaveBeenCalled());
    // The listener keeps their place rather than being dropped to 0:00.
    await vi.waitFor(() => expect(engine.store.get().currentTime).toBe(75));
    expect(engine.store.get().track?.id).toBe('1');
  });

  it('surfaces a helpful error when signing fails outright', async () => {
    signMock.mockRejectedValueOnce(Object.assign(new Error('Object not found'), { status: 404 }));
    await engine.playTracks(tracks);
    expect(engine.store.get().status).toBe('error');
    expect(engine.store.get().error?.kind).toBe('missing-file');
  });

  it('queue controls surface through the engine', async () => {
    await engine.playTracks(tracks, { startIndex: 0 });
    expect(engine.canGoNext()).toBe(true);
    expect(engine.canGoPrevious()).toBe(false);

    engine.playNext([makeTrack('9')]);
    expect(engine.getUpcoming()[0]?.track.id).toBe('9');

    engine.enqueue([makeTrack('8')]);
    expect(engine.getUpcoming().at(-1)?.track.id).toBe('8');
  });

  it('toggling shuffle keeps the current track playing', async () => {
    await engine.playTracks(tracks, { startIndex: 1 });
    engine.toggleShuffle();
    expect(engine.store.get().queue.shuffle).toBe(true);
    expect(engine.store.get().track?.id).toBe('2');
  });

  it('cycles repeat modes and persists the choice', async () => {
    expect(engine.cycleRepeat()).toBe('all');
    expect(engine.cycleRepeat()).toBe('one');
    expect(engine.cycleRepeat()).toBe('off');
    expect(JSON.parse(localStorage.getItem('resonance:preferences')!).repeat).toBe('off');
  });

  it('restores persisted volume, shuffle and repeat on construction', () => {
    localStorage.setItem('resonance:preferences', JSON.stringify({
      volume: 0.3, shuffle: true, repeat: 'all', theme: 'dark',
    }));
    const restored = new PlaybackEngine();
    expect(restored.store.get().volume).toBe(0.3);
    expect(restored.store.get().queue.shuffle).toBe(true);
    expect(restored.store.get().queue.repeat).toBe('all');
  });

  it('reset clears the queue and the current track', async () => {
    await engine.playTracks(tracks);
    engine.reset();
    expect(engine.store.get().status).toBe('idle');
    expect(engine.store.get().track).toBeNull();
    expect(engine.store.get().queue.tracks).toHaveLength(0);
  });

  it('attaching twice does not double-register listeners', async () => {
    engine.attach(audio);
    engine.attach(audio);
    await engine.playTracks(tracks, { startIndex: 0 });
    audio.dispatchEvent(new Event('ended'));
    // A duplicated 'ended' handler would skip two tracks at once.
    await vi.waitFor(() => expect(engine.store.get().track?.id).toBe('2'));
  });
});
