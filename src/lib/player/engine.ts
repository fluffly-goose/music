/**
 * The playback service. One audio element for the whole application.
 *
 * Two things drive the design here:
 *
 *  1. There is exactly one <audio>, created once and reused. Swapping tracks
 *     changes its `src` rather than building a new element, which is what keeps
 *     iOS's "this element was started by a user gesture" permission alive - a
 *     freshly created element would need a new tap to play.
 *
 *  2. Audio is fetched through short-lived signed URLs. A URL can die between
 *     being minted and being used, so every load path can re-sign once and
 *     resume at the same offset instead of dropping the user back to silence.
 */

import type { Track } from '../library/types';
import { trackArtwork } from '../library/types';
import { connection } from '../connection/manager';
import { library } from '../library/service';
import { artworkUrl } from '../library/artwork';
import { signedUrls } from './urls';
import { createStore, type Store } from '../state/store';
import {
  cycleRepeat,
  emptyQueue,
  currentTrack as queueCurrentTrack,
  enqueue as queueEnqueue,
  hasNext,
  hasPrevious,
  jumpTo,
  next as queueNext,
  playNext as queuePlayNext,
  previous as queuePrevious,
  removeAt,
  setQueue,
  setRepeat,
  setShuffle,
  upcoming,
  type QueueState,
  type RepeatMode,
} from './queue';
import {
  setMediaSessionHandlers,
  setMediaSessionMetadata,
  setPlaybackState,
  setPositionState,
} from './mediaSession';
import { AppError, toAppError } from '../utils/errors';
import { loadPreferences, savePreferences } from '../connection/storage';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerState {
  status: PlaybackStatus;
  track: Track | null;
  queue: QueueState;
  currentTime: number;
  duration: number;
  /** Seconds of audio buffered ahead, for the progress bar's secondary fill. */
  buffered: number;
  volume: number;
  muted: boolean;
  error: AppError | null;
  /** True while a user drag is in progress, so timeupdate stops fighting it. */
  seeking: boolean;
}

/** Pressing "previous" this far into a track restarts it instead of going back. */
const RESTART_THRESHOLD_SECONDS = 3;
/** A track counts as "played" for history after this long. */
const HISTORY_THRESHOLD_SECONDS = 15;

export class PlaybackEngine {
  readonly store: Store<PlayerState>;

  private audio: HTMLAudioElement | null = null;
  private boundAudio = new WeakSet<HTMLAudioElement>();
  /** Guards against a slow load for track A finishing after the user picked B. */
  private loadToken = 0;
  private retriedForToken = new Set<number>();
  private historyRecordedFor: string | null = null;
  private pendingSeek: number | null = null;

  constructor() {
    const prefs = loadPreferences();
    this.store = createStore<PlayerState>({
      status: 'idle',
      track: null,
      queue: { ...emptyQueue(), shuffle: prefs.shuffle, repeat: prefs.repeat },
      currentTime: 0,
      duration: 0,
      buffered: 0,
      volume: prefs.volume,
      muted: false,
      error: null,
      seeking: false,
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Attaches to the persistent <audio>. Safe to call on every page navigation:
   * with Astro's transition:persist the same node survives, and the WeakSet
   * stops listeners being stacked. If the node ever *is* replaced, this rebinds
   * transparently.
   */
  attach(element: HTMLAudioElement): void {
    this.audio = element;
    if (this.boundAudio.has(element)) return;
    this.boundAudio.add(element);

    element.preload = 'metadata';
    element.volume = this.store.get().volume;

    element.addEventListener('loadedmetadata', () => {
      this.store.set({ duration: Number.isFinite(element.duration) ? element.duration : 0 });
      // Resume position after a mid-track URL refresh.
      if (this.pendingSeek != null) {
        try {
          element.currentTime = this.pendingSeek;
        } catch {
          /* some formats reject an early seek; harmless */
        }
        this.pendingSeek = null;
      }
    });

    element.addEventListener('timeupdate', () => {
      if (this.store.get().seeking) return;
      this.store.set({ currentTime: element.currentTime });
      this.maybeRecordHistory(element.currentTime);
      setPositionState(element.duration, element.currentTime, element.playbackRate);
    });

    element.addEventListener('progress', () => {
      const ranges = element.buffered;
      if (ranges.length > 0) {
        this.store.set({ buffered: ranges.end(ranges.length - 1) });
      }
    });

    element.addEventListener('playing', () => {
      this.store.set({ status: 'playing', error: null });
      setPlaybackState('playing');
    });

    element.addEventListener('pause', () => {
      // `pause` also fires at the natural end of a track; `ended` handles that.
      if (element.ended) return;
      this.store.set({ status: 'paused' });
      setPlaybackState('paused');
    });

    element.addEventListener('waiting', () => {
      if (this.store.get().status === 'playing') this.store.set({ status: 'loading' });
    });

    element.addEventListener('ended', () => {
      void this.next({ auto: true });
    });

    element.addEventListener('error', () => {
      void this.handleAudioError();
    });

    this.registerMediaSession();
  }

  private registerMediaSession(): void {
    setMediaSessionHandlers({
      play: () => void this.play(),
      pause: () => this.pause(),
      previoustrack: () => void this.previous(),
      nexttrack: () => void this.next(),
      seekto: (time) => this.seek(time),
      seekbackward: (offset) => this.seek(this.store.get().currentTime - offset),
      seekforward: (offset) => this.seek(this.store.get().currentTime + offset),
    });
  }

  private requireAudio(): HTMLAudioElement {
    if (!this.audio) {
      throw new AppError('playback', 'The audio player is not ready yet.');
    }
    return this.audio;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Starts a list of tracks. This is the single entry point every "play"
   * button in the UI funnels into.
   */
  async playTracks(
    tracks: Track[],
    options: { startIndex?: number; shuffle?: boolean } = {},
  ): Promise<void> {
    if (tracks.length === 0) return;
    const queue = setQueue(this.store.get().queue, tracks, options);
    this.store.set({ queue });
    this.persistPreferences();
    await this.loadCurrent({ autoplay: true });
  }

  /** Resumes, or starts the queue if one is loaded but idle. */
  async play(): Promise<void> {
    const state = this.store.get();
    if (!state.track) {
      if (queueCurrentTrack(state.queue)) await this.loadCurrent({ autoplay: true });
      return;
    }
    const audio = this.requireAudio();
    try {
      await audio.play();
    } catch (raw) {
      // iOS rejects play() without a user gesture. That is not an error worth
      // showing - the user simply has to tap once.
      const name = (raw as { name?: string })?.name;
      if (name === 'NotAllowedError') {
        this.store.set({ status: 'paused' });
        return;
      }
      if (name === 'AbortError') return; // superseded by a newer load
      this.store.set({ status: 'error', error: toAppError(raw, 'Playing') });
    }
  }

  pause(): void {
    this.audio?.pause();
    this.store.set({ status: 'paused' });
    setPlaybackState('paused');
  }

  async toggle(): Promise<void> {
    const status = this.store.get().status;
    if (status === 'playing' || status === 'loading') this.pause();
    else await this.play();
  }

  async next(options: { auto?: boolean } = {}): Promise<void> {
    const state = this.store.get();

    // Repeat-one on natural end: replay without touching the queue.
    if (options.auto && state.queue.repeat === 'one') {
      this.historyRecordedFor = null;
      this.seek(0);
      await this.play();
      return;
    }

    const advanced = queueNext(state.queue, options);
    if (!advanced) {
      // End of queue: stop cleanly and rewind, don't error.
      this.pause();
      this.seek(0);
      setPlaybackState('paused');
      return;
    }
    this.store.set({ queue: advanced });
    await this.loadCurrent({ autoplay: true });
  }

  /** Restarts the current track unless pressed within the first few seconds. */
  async previous(): Promise<void> {
    const state = this.store.get();
    if (state.currentTime > RESTART_THRESHOLD_SECONDS) {
      this.seek(0);
      return;
    }
    const stepped = queuePrevious(state.queue);
    if (!stepped) {
      this.seek(0);
      return;
    }
    this.store.set({ queue: stepped });
    await this.loadCurrent({ autoplay: true });
  }

  async jumpTo(orderIndex: number): Promise<void> {
    const jumped = jumpTo(this.store.get().queue, orderIndex);
    if (!jumped) return;
    this.store.set({ queue: jumped });
    await this.loadCurrent({ autoplay: true });
  }

  seek(seconds: number): void {
    const audio = this.audio;
    if (!audio) return;
    const duration = this.store.get().duration || audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const target = Math.min(Math.max(seconds, 0), duration);
    try {
      audio.currentTime = target;
      this.store.set({ currentTime: target });
    } catch (error) {
      console.warn('[player] seek rejected', error);
    }
  }

  /** Called while a scrub is in flight so timeupdate does not fight the thumb. */
  setSeeking(seeking: boolean): void {
    this.store.set({ seeking });
  }

  setVolume(volume: number): void {
    const clamped = Math.min(Math.max(volume, 0), 1);
    if (this.audio) this.audio.volume = clamped;
    this.store.set({ volume: clamped, muted: clamped === 0 });
    this.persistPreferences();
  }

  toggleMute(): void {
    const audio = this.audio;
    const muted = !this.store.get().muted;
    if (audio) audio.muted = muted;
    this.store.set({ muted });
  }

  // -------------------------------------------------------------------------
  // Queue controls
  // -------------------------------------------------------------------------

  toggleShuffle(): void {
    this.store.set({ queue: setShuffle(this.store.get().queue, !this.store.get().queue.shuffle) });
    this.persistPreferences();
  }

  cycleRepeat(): RepeatMode {
    const queue = cycleRepeat(this.store.get().queue);
    this.store.set({ queue });
    this.persistPreferences();
    return queue.repeat;
  }

  setRepeat(mode: RepeatMode): void {
    this.store.set({ queue: setRepeat(this.store.get().queue, mode) });
    this.persistPreferences();
  }

  playNext(tracks: Track[]): void {
    this.store.set({ queue: queuePlayNext(this.store.get().queue, tracks) });
  }

  enqueue(tracks: Track[]): void {
    this.store.set({ queue: queueEnqueue(this.store.get().queue, tracks) });
  }

  removeFromQueue(orderIndex: number): void {
    this.store.set({ queue: removeAt(this.store.get().queue, orderIndex) });
  }

  getUpcoming(limit = 100) {
    return upcoming(this.store.get().queue, limit);
  }

  canGoNext(): boolean {
    return hasNext(this.store.get().queue);
  }

  canGoPrevious(): boolean {
    return hasPrevious(this.store.get().queue);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Points the audio element at the current queue entry.
   * `resumeAt` is used by the refresh path so a dead URL does not lose the
   * listener's place.
   */
  private async loadCurrent(options: { autoplay?: boolean; resumeAt?: number } = {}): Promise<void> {
    const track = queueCurrentTrack(this.store.get().queue);
    if (!track) {
      this.store.set({ status: 'idle', track: null, currentTime: 0, duration: 0 });
      return;
    }

    const token = ++this.loadToken;
    this.historyRecordedFor = null;
    this.store.set({
      status: 'loading',
      track,
      error: null,
      currentTime: options.resumeAt ?? 0,
      duration: 0,
      buffered: 0,
    });

    // Update the lock screen immediately; artwork catches up asynchronously.
    setMediaSessionMetadata(track, null);
    void artworkUrl(trackArtwork(track)).then((url) => {
      if (this.loadToken === token) setMediaSessionMetadata(track, url);
    });

    try {
      const client = connection.requireClient();
      const url = await signedUrls.get(client, connection.getBucket(), track.audio_path);

      // A newer track was picked while we were signing - abandon this load.
      if (this.loadToken !== token) return;

      const audio = this.requireAudio();
      this.pendingSeek = options.resumeAt ?? null;
      audio.src = url;
      audio.load();

      if (options.autoplay) await this.play();
    } catch (raw) {
      if (this.loadToken !== token) return;
      const error = toAppError(raw, `Loading "${track.title}"`);
      this.store.set({ status: 'error', error });
    }
  }

  /**
   * The audio element failed. The overwhelmingly common cause is a signed URL
   * that expired mid-listen, so re-sign once and resume where we were. Only if
   * that also fails do we surface an error.
   */
  private async handleAudioError(): Promise<void> {
    const state = this.store.get();
    const track = state.track;
    const audio = this.audio;
    if (!track || !audio) return;

    const mediaError = audio.error;
    const token = this.loadToken;

    // Retry exactly once per load, or a broken file would loop forever.
    if (!this.retriedForToken.has(token)) {
      this.retriedForToken.add(token);
      const resumeAt = state.currentTime;
      try {
        const client = connection.requireClient();
        signedUrls.invalidate(connection.getBucket(), track.audio_path);
        await signedUrls.get(client, connection.getBucket(), track.audio_path, { force: true });
        await this.loadCurrent({ autoplay: true, resumeAt });
        return;
      } catch {
        // fall through to the reported error below
      }
    }

    // MEDIA_ERR_SRC_NOT_SUPPORTED: the browser cannot decode this codec.
    const unsupported = mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
    const error = unsupported
      ? new AppError('unsupported-format', `Safari cannot play "${track.title}".`, {
          hint: 'This browser supports MP3, AAC/M4A, ALAC, WAV and AIFF. FLAC and Ogg are not playable in Safari - convert those files to AAC or ALAC.',
        })
      : new AppError('playback', `Playback of "${track.title}" failed.`, {
          hint: 'Check your connection, then try again. If it keeps failing, the file may be missing from storage.',
        });

    this.store.set({ status: 'error', error });
    setPlaybackState('paused');
  }

  /** Records a play once the listener is clearly committed to the track. */
  private maybeRecordHistory(currentTime: number): void {
    const track = this.store.get().track;
    if (!track || this.historyRecordedFor === track.id) return;
    const threshold = Math.min(HISTORY_THRESHOLD_SECONDS, (track.duration_seconds ?? 30) / 2);
    if (currentTime < threshold) return;
    this.historyRecordedFor = track.id;
    void library.recordPlay(track.id);
  }

  private persistPreferences(): void {
    const state = this.store.get();
    const prefs = loadPreferences();
    savePreferences({
      ...prefs,
      volume: state.volume,
      shuffle: state.queue.shuffle,
      repeat: state.queue.repeat,
    });
  }

  /** Clears everything - used when disconnecting or switching projects. */
  reset(): void {
    this.loadToken++;
    this.retriedForToken.clear();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    signedUrls.clear();
    this.store.set({
      status: 'idle',
      track: null,
      queue: emptyQueue(),
      currentTime: 0,
      duration: 0,
      buffered: 0,
      error: null,
    });
    setMediaSessionMetadata(null, null);
    setPlaybackState('none');
  }
}

export const player = new PlaybackEngine();
