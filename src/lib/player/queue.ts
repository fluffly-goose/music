/**
 * Queue model - pure data, no audio, no DOM.
 *
 * Shuffle keeps the original list intact and maintains a separate order array.
 * That is what lets you toggle shuffle off mid-album and land back in the real
 * track order at the song you are actually hearing, the way a real player does.
 */

import type { Track } from '../library/types';

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueState {
  tracks: Track[];
  /** Indices into `tracks`, in the order they will play. */
  order: number[];
  /** Position within `order`, or -1 when nothing is loaded. */
  cursor: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export function emptyQueue(): QueueState {
  return { tracks: [], order: [], cursor: -1, shuffle: false, repeat: 'off' };
}

export function currentTrack(state: QueueState): Track | null {
  const index = state.order[state.cursor];
  if (index === undefined) return null;
  return state.tracks[index] ?? null;
}

function sequentialOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/** Fisher-Yates over a copy. `random` is injectable so tests are deterministic. */
function shuffled(indices: number[], random: () => number): number[] {
  const copy = [...indices];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Replaces the queue.
 * When shuffling, the chosen start track is pulled to the front so pressing
 * "shuffle" on an album still begins with something you asked for.
 */
export function setQueue(
  state: QueueState,
  tracks: Track[],
  options: { startIndex?: number; shuffle?: boolean; random?: () => number } = {},
): QueueState {
  const shuffle = options.shuffle ?? state.shuffle;
  const random = options.random ?? Math.random;
  const startIndex = clamp(options.startIndex ?? 0, 0, Math.max(0, tracks.length - 1));

  if (tracks.length === 0) {
    return { ...state, tracks: [], order: [], cursor: -1, shuffle };
  }

  let order: number[];
  let cursor: number;

  if (shuffle) {
    const rest = sequentialOrder(tracks.length).filter((i) => i !== startIndex);
    order = [startIndex, ...shuffled(rest, random)];
    cursor = 0;
  } else {
    order = sequentialOrder(tracks.length);
    cursor = startIndex;
  }

  return { ...state, tracks, order, cursor, shuffle };
}

/**
 * Toggles shuffle without changing what is playing.
 * Turning it on reshuffles everything *after* the current track; turning it off
 * restores natural order and re-points the cursor at the same track.
 */
export function setShuffle(
  state: QueueState,
  shuffle: boolean,
  random: () => number = Math.random,
): QueueState {
  if (shuffle === state.shuffle) return state;
  if (state.tracks.length === 0) return { ...state, shuffle };

  const playing = state.order[state.cursor];

  if (shuffle) {
    if (playing === undefined) {
      return { ...state, shuffle: true, order: shuffled(sequentialOrder(state.tracks.length), random) };
    }
    const rest = sequentialOrder(state.tracks.length).filter((i) => i !== playing);
    return { ...state, shuffle: true, order: [playing, ...shuffled(rest, random)], cursor: 0 };
  }

  const order = sequentialOrder(state.tracks.length);
  return { ...state, shuffle: false, order, cursor: playing === undefined ? -1 : playing };
}

export function setRepeat(state: QueueState, repeat: RepeatMode): QueueState {
  return { ...state, repeat };
}

export function cycleRepeat(state: QueueState): QueueState {
  const next: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };
  return setRepeat(state, next[state.repeat]);
}

/**
 * Advance.
 * `auto` marks a track ending on its own, which is the only case where
 * repeat-one replays the same track; pressing next always moves on.
 */
export function next(state: QueueState, options: { auto?: boolean } = {}): QueueState | null {
  if (state.order.length === 0) return null;
  if (options.auto && state.repeat === 'one') return { ...state };

  const candidate = state.cursor + 1;
  if (candidate < state.order.length) return { ...state, cursor: candidate };
  if (state.repeat === 'all') return { ...state, cursor: 0 };
  return null; // end of queue
}

/** Step back. Repeat-all wraps to the end. */
export function previous(state: QueueState): QueueState | null {
  if (state.order.length === 0) return null;
  const candidate = state.cursor - 1;
  if (candidate >= 0) return { ...state, cursor: candidate };
  if (state.repeat === 'all') return { ...state, cursor: state.order.length - 1 };
  return null;
}

/** Plays next, right after the current track. */
export function playNext(state: QueueState, tracks: Track[]): QueueState {
  if (tracks.length === 0) return state;
  if (state.tracks.length === 0) return setQueue(state, tracks, { startIndex: 0 });

  const newTracks = [...state.tracks, ...tracks];
  const newIndices = tracks.map((_, i) => state.tracks.length + i);
  const order = [...state.order];
  order.splice(state.cursor + 1, 0, ...newIndices);
  return { ...state, tracks: newTracks, order };
}

/** Appends to the end of the queue. */
export function enqueue(state: QueueState, tracks: Track[]): QueueState {
  if (tracks.length === 0) return state;
  if (state.tracks.length === 0) return setQueue(state, tracks, { startIndex: 0 });

  const newTracks = [...state.tracks, ...tracks];
  const newIndices = tracks.map((_, i) => state.tracks.length + i);
  return { ...state, tracks: newTracks, order: [...state.order, ...newIndices] };
}

/** Jumps to a position in the play order (tapping a row in the Queue sheet). */
export function jumpTo(state: QueueState, orderIndex: number): QueueState | null {
  if (orderIndex < 0 || orderIndex >= state.order.length) return null;
  return { ...state, cursor: orderIndex };
}

/** Removes one entry by its position in the play order. */
export function removeAt(state: QueueState, orderIndex: number): QueueState {
  if (orderIndex < 0 || orderIndex >= state.order.length) return state;
  const order = [...state.order];
  order.splice(orderIndex, 1);
  // Keep the cursor pointing at the same track when removing above it.
  let cursor = state.cursor;
  if (orderIndex < state.cursor) cursor -= 1;
  else if (orderIndex === state.cursor) cursor = Math.min(cursor, order.length - 1);
  return { ...state, order, cursor };
}

/** The tracks still ahead, in play order - what the Queue sheet renders. */
export function upcoming(state: QueueState, limit = 100): { track: Track; orderIndex: number }[] {
  const out: { track: Track; orderIndex: number }[] = [];
  for (let i = state.cursor + 1; i < state.order.length && out.length < limit; i++) {
    const track = state.tracks[state.order[i]!];
    if (track) out.push({ track, orderIndex: i });
  }
  return out;
}

export function hasNext(state: QueueState): boolean {
  return next(state) !== null;
}

export function hasPrevious(state: QueueState): boolean {
  return previous(state) !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
