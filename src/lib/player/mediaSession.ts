/**
 * Media Session integration - lock screen / Control Center metadata on iOS,
 * and the same on Android and desktop.
 *
 * Every call is feature-detected. Where the API is missing the app simply loses
 * the lock-screen artwork, and nothing else changes.
 */

import type { Track } from '../library/types';
import { trackArtistName } from '../library/types';

type Handlers = {
  play: () => void;
  pause: () => void;
  previoustrack: () => void;
  nexttrack: () => void;
  seekto?: (time: number) => void;
  seekbackward?: (offset: number) => void;
  seekforward?: (offset: number) => void;
};

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function setMediaSessionHandlers(handlers: Handlers): void {
  if (!supported()) return;
  const session = navigator.mediaSession;

  const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Safari throws for actions it does not implement rather than ignoring them.
    }
  };

  bind('play', () => handlers.play());
  bind('pause', () => handlers.pause());
  bind('previoustrack', () => handlers.previoustrack());
  bind('nexttrack', () => handlers.nexttrack());

  if (handlers.seekto) {
    bind('seekto', (details) => {
      if (typeof details.seekTime === 'number') handlers.seekto!(details.seekTime);
    });
  }
  if (handlers.seekbackward) {
    bind('seekbackward', (details) => handlers.seekbackward!(details.seekOffset ?? 10));
  }
  if (handlers.seekforward) {
    bind('seekforward', (details) => handlers.seekforward!(details.seekOffset ?? 10));
  }
}

export function setMediaSessionMetadata(track: Track | null, artworkUrl: string | null): void {
  if (!supported()) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }

  const artwork: MediaImage[] = artworkUrl
    ? [
        // iOS picks a size from this list; declaring several of the same source
        // is the documented way to say "whatever you need".
        { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '128x128', type: 'image/jpeg' },
      ]
    : [];

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: trackArtistName(track),
      album: track.album?.title ?? '',
      artwork,
    });
  } catch (error) {
    console.warn('[mediaSession] metadata rejected', error);
  }
}

export function setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!supported()) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    /* non-fatal */
  }
}

/** Drives the scrubber in Control Center. Not implemented in Safari today. */
export function setPositionState(duration: number, position: number, rate = 1): void {
  if (!supported() || typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate: rate,
    });
  } catch {
    /* Safari throws on some position updates; harmless. */
  }
}
