import { describe, it, expect } from 'vitest';
import {
  cycleRepeat, emptyQueue, currentTrack, enqueue, hasNext, hasPrevious, jumpTo,
  next, playNext, previous, removeAt, setQueue, setRepeat, setShuffle, upcoming,
} from '@/lib/player/queue';
import type { Track } from '@/lib/library/types';

function track(id: string, title = `Track ${id}`): Track {
  return {
    id, album_id: 'album-1', artist_id: 'artist-1', title,
    track_no: Number(id), disc_no: 1, duration_seconds: 180,
    audio_path: `owner/albums/album-1/${id}.mp3`, mime_type: 'audio/mpeg',
    file_size: 1000, genre: null, year: 2024, created_at: '2024-01-01T00:00:00Z',
  };
}

const tracks = ['1', '2', '3', '4', '5'].map((id) => track(id));

/** Deterministic "random" so shuffle assertions are stable. */
function seededRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('queue: construction', () => {
  it('starts empty with no current track', () => {
    const q = emptyQueue();
    expect(q.tracks).toHaveLength(0);
    expect(q.cursor).toBe(-1);
    expect(currentTrack(q)).toBeNull();
  });

  it('plays from the requested index in natural order', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 2 });
    expect(q.order).toEqual([0, 1, 2, 3, 4]);
    expect(currentTrack(q)?.id).toBe('3');
  });

  it('clamps an out-of-range start index instead of throwing', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 99 });
    expect(currentTrack(q)?.id).toBe('5');
  });

  it('handles an empty track list', () => {
    const q = setQueue(emptyQueue(), [], { startIndex: 0 });
    expect(currentTrack(q)).toBeNull();
    expect(q.cursor).toBe(-1);
  });

  it('shuffled start puts the chosen track first and keeps every track exactly once', () => {
    const q = setQueue(emptyQueue(), tracks, {
      startIndex: 3, shuffle: true, random: seededRandom(),
    });
    expect(currentTrack(q)?.id).toBe('4');
    expect([...q.order].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('queue: advancing', () => {
  it('moves forward through the order', () => {
    let q = setQueue(emptyQueue(), tracks, { startIndex: 0 });
    q = next(q)!;
    expect(currentTrack(q)?.id).toBe('2');
  });

  it('returns null at the end when repeat is off', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 4 });
    expect(next(q)).toBeNull();
    expect(hasNext(q)).toBe(false);
  });

  it('wraps to the start when repeat is all', () => {
    const q = setRepeat(setQueue(emptyQueue(), tracks, { startIndex: 4 }), 'all');
    expect(currentTrack(next(q)!)?.id).toBe('1');
  });

  it('repeat-one holds position only when the track ended by itself', () => {
    const q = setRepeat(setQueue(emptyQueue(), tracks, { startIndex: 1 }), 'one');
    expect(currentTrack(next(q, { auto: true })!)?.id).toBe('2');
    // An explicit "next" press still moves on.
    expect(currentTrack(next(q)!)?.id).toBe('3');
  });

  it('steps backward and stops at the start when repeat is off', () => {
    let q = setQueue(emptyQueue(), tracks, { startIndex: 1 });
    q = previous(q)!;
    expect(currentTrack(q)?.id).toBe('1');
    expect(previous(q)).toBeNull();
    expect(hasPrevious(q)).toBe(false);
  });

  it('wraps backward to the end when repeat is all', () => {
    const q = setRepeat(setQueue(emptyQueue(), tracks, { startIndex: 0 }), 'all');
    expect(currentTrack(previous(q)!)?.id).toBe('5');
  });
});

describe('queue: shuffle toggling', () => {
  it('keeps the current track playing when shuffle is switched on', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 2 });
    const shuffledQueue = setShuffle(q, true, seededRandom());
    expect(currentTrack(shuffledQueue)?.id).toBe('3');
    expect([...shuffledQueue.order].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('restores natural order and stays on the same track when switched off', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 0, shuffle: true, random: seededRandom() });
    const playing = currentTrack(q)!;
    const unshuffled = setShuffle(q, false);
    expect(unshuffled.order).toEqual([0, 1, 2, 3, 4]);
    expect(currentTrack(unshuffled)?.id).toBe(playing.id);
  });

  it('is a no-op when the mode is unchanged', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 0 });
    expect(setShuffle(q, false)).toBe(q);
  });

  it('cycles repeat off -> all -> one -> off', () => {
    let q = setQueue(emptyQueue(), tracks);
    expect((q = cycleRepeat(q)).repeat).toBe('all');
    expect((q = cycleRepeat(q)).repeat).toBe('one');
    expect((q = cycleRepeat(q)).repeat).toBe('off');
  });
});

describe('queue: manipulation', () => {
  it('play-next inserts directly after the current track', () => {
    const q = playNext(setQueue(emptyQueue(), tracks, { startIndex: 0 }), [track('9', 'Inserted')]);
    expect(currentTrack(next(q)!)?.title).toBe('Inserted');
  });

  it('enqueue appends to the very end', () => {
    const q = enqueue(setQueue(emptyQueue(), tracks, { startIndex: 0 }), [track('9', 'Appended')]);
    expect(q.order).toHaveLength(6);
    expect(q.tracks[q.order[5]!]?.title).toBe('Appended');
  });

  it('play-next on an empty queue just starts playing', () => {
    expect(currentTrack(playNext(emptyQueue(), [track('7')]))?.id).toBe('7');
  });

  it('jumping to a position changes the current track', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 0 });
    expect(currentTrack(jumpTo(q, 3)!)?.id).toBe('4');
    expect(jumpTo(q, 99)).toBeNull();
  });

  it('removing an entry above the cursor keeps the same track playing', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 3 });
    const after = removeAt(q, 1);
    expect(currentTrack(after)?.id).toBe('4');
    expect(after.order).toHaveLength(4);
  });

  it('lists only what is still ahead', () => {
    const q = setQueue(emptyQueue(), tracks, { startIndex: 2 });
    expect(upcoming(q).map((u) => u.track.id)).toEqual(['4', '5']);
  });
});
