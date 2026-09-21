/**
 * Binds the persistent player chrome to the playback store.
 *
 * This runs once per page load. Because the chrome nodes are persisted by
 * Astro, the bindings are idempotent: a `data-bound` flag stops listeners
 * stacking up as the user moves between screens.
 */

import { player } from '../player/engine';
import { select } from '../state/store';
import { artworkUrl } from '../library/artwork';
import { trackArtwork, trackArtistName, type Track } from '../library/types';
import { formatDuration, escapeHtml } from '../utils/format';
import { icons } from './icons';
import { showToast } from './render';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** True on iOS, where HTMLMediaElement.volume is read-only. */
function volumeIsSoftwareControllable(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return !isIOS;
}

let sheetOpen = false;
let queueOpen = false;

export function initPlayerUI(): void {
  const audio = $<HTMLAudioElement>('app-audio');
  if (audio) player.attach(audio);

  bindMini();
  bindNowPlaying();
  bindQueue();
  bindActionSheet();
  subscribeToStore();
}

/* ------------------------------------------------------------------------ */
/* Mini player                                                               */
/* ------------------------------------------------------------------------ */

function bindMini(): void {
  const mini = $('mini-player');
  if (!mini || mini.dataset.bound === '1') return;
  mini.dataset.bound = '1';

  $('mini-expand')?.addEventListener('click', openNowPlaying);
  $('mini-play')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void player.toggle();
  });
  $('mini-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void player.next();
  });

  // Swipe up on the mini player opens Now Playing, like the real thing.
  let startY = 0;
  mini.addEventListener('touchstart', (e) => { startY = e.touches[0]?.clientY ?? 0; }, { passive: true });
  mini.addEventListener('touchend', (e) => {
    const endY = e.changedTouches[0]?.clientY ?? 0;
    if (startY - endY > 40) openNowPlaying();
  }, { passive: true });
}

/* ------------------------------------------------------------------------ */
/* Now Playing                                                               */
/* ------------------------------------------------------------------------ */

function openNowPlaying(): void {
  const sheet = $('now-playing');
  if (!sheet) return;
  sheet.classList.add('is-open');
  sheetOpen = true;
  document.body.style.overflow = 'hidden';
}

function closeNowPlaying(): void {
  $('now-playing')?.classList.remove('is-open');
  sheetOpen = false;
  if (!queueOpen) document.body.style.overflow = '';
}

function bindNowPlaying(): void {
  const sheet = $('now-playing');
  if (!sheet || sheet.dataset.bound === '1') return;
  sheet.dataset.bound = '1';

  $('np-close')?.addEventListener('click', closeNowPlaying);
  $('np-play')?.addEventListener('click', () => void player.toggle());
  $('np-next')?.addEventListener('click', () => void player.next());
  $('np-prev')?.addEventListener('click', () => void player.previous());
  $('np-shuffle')?.addEventListener('click', () => player.toggleShuffle());
  $('np-repeat')?.addEventListener('click', () => player.cycleRepeat());
  $('np-queue-open')?.addEventListener('click', openQueue);

  // Scrubbing: hold the store's `seeking` flag for the duration of the drag so
  // incoming timeupdate events do not yank the thumb back.
  const scrub = $<HTMLInputElement>('np-scrub');
  if (scrub) {
    const beginSeek = () => player.setSeeking(true);
    const preview = () => {
      const { duration } = player.store.get();
      const time = (Number(scrub.value) / 1000) * duration;
      const elapsed = $('np-elapsed');
      if (elapsed) elapsed.textContent = formatDuration(time);
      scrub.style.setProperty('--progress', `${Number(scrub.value) / 10}%`);
    };
    const commit = () => {
      const { duration } = player.store.get();
      player.seek((Number(scrub.value) / 1000) * duration);
      player.setSeeking(false);
    };

    scrub.addEventListener('pointerdown', beginSeek);
    scrub.addEventListener('touchstart', beginSeek, { passive: true });
    scrub.addEventListener('input', preview);
    scrub.addEventListener('change', commit);
    scrub.addEventListener('pointerup', commit);
  }

  // Volume is hardware-only on iOS; showing a dead slider would be a lie.
  const volumeWrap = $('np-volume-wrap');
  if (!volumeIsSoftwareControllable()) {
    volumeWrap?.classList.add('hidden');
  } else {
    const volume = $<HTMLInputElement>('np-volume');
    volume?.addEventListener('input', () => {
      player.setVolume(Number(volume.value) / 100);
      volume.style.setProperty('--progress', `${volume.value}%`);
    });
    $('np-mute')?.addEventListener('click', () => player.toggleMute());
  }

  // Swipe down to dismiss.
  let startY = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0]?.clientY ?? 0; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    const endY = e.changedTouches[0]?.clientY ?? 0;
    if (endY - startY > 90) closeNowPlaying();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (queueOpen) closeQueue();
      else if (sheetOpen) closeNowPlaying();
    }
    // Space toggles playback, unless the user is typing.
    const target = e.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
    if (e.code === 'Space' && !typing && player.store.get().track) {
      e.preventDefault();
      void player.toggle();
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Queue                                                                     */
/* ------------------------------------------------------------------------ */

function openQueue(): void {
  renderQueue();
  $('queue-sheet')?.classList.add('is-open');
  queueOpen = true;
  document.body.style.overflow = 'hidden';
}

function closeQueue(): void {
  $('queue-sheet')?.classList.remove('is-open');
  queueOpen = false;
  if (!sheetOpen) document.body.style.overflow = '';
}

function bindQueue(): void {
  const sheet = $('queue-sheet');
  if (!sheet || sheet.dataset.bound === '1') return;
  sheet.dataset.bound = '1';

  $('queue-close')?.addEventListener('click', closeQueue);

  // One delegated handler for the whole list.
  $('queue-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-queue-remove]');
    if (remove) {
      player.removeFromQueue(Number(remove.dataset.queueRemove));
      renderQueue();
      return;
    }
    const row = target.closest<HTMLElement>('[data-queue-index]');
    if (row) {
      void player.jumpTo(Number(row.dataset.queueIndex)).then(renderQueue);
    }
  });
}

function renderQueue(): void {
  const list = $('queue-list');
  if (!list) return;

  const upcoming = player.getUpcoming();
  if (upcoming.length === 0) {
    list.innerHTML =
      `<p class="text-center text-[14px] py-12" style="color:var(--muted)">Nothing up next.</p>`;
    return;
  }

  list.innerHTML = upcoming
    .map(
      ({ track, orderIndex }) => `
<div class="flex items-center gap-3 px-5 py-2 row-press" data-queue-index="${orderIndex}" role="button" tabindex="0">
  <div class="w-10 h-10 rounded overflow-hidden shrink-0" style="background:var(--surface-2)">
    <img class="artwork w-full h-full" alt=""
         ${track.album?.cover_path ? `data-art-path="${escapeHtml(track.album.cover_path)}"` : ''}
         data-art-seed="${escapeHtml(track.album?.title ?? track.title)}">
  </div>
  <div class="min-w-0 flex-1">
    <div class="text-[14px] truncate">${escapeHtml(track.title)}</div>
    <div class="text-[12px] truncate" style="color:var(--muted)">${escapeHtml(trackArtistName(track))}</div>
  </div>
  <button class="tap shrink-0 -mr-2" style="color:var(--subtle)"
          data-queue-remove="${orderIndex}" aria-label="Remove ${escapeHtml(track.title)} from queue">
    ${icons.close(17)}
  </button>
</div>`,
    )
    .join('');

  void import('../library/artwork').then((m) => m.hydrateArtwork(list));
}

/* ------------------------------------------------------------------------ */
/* Track action sheet                                                        */
/* ------------------------------------------------------------------------ */

export interface ActionItem {
  label: string;
  icon?: string;
  destructive?: boolean;
  onSelect: () => void | Promise<void>;
}

let actionHandlers: ActionItem[] = [];

export function openActionSheet(title: string, items: ActionItem[]): void {
  const sheet = $('action-sheet');
  const panel = $('action-panel');
  if (!sheet || !panel) return;

  actionHandlers = items;
  panel.innerHTML = `
<div class="px-4 pt-3 pb-2 text-[13px] font-medium truncate" style="color:var(--muted)">
  ${escapeHtml(title)}
</div>
${items
  .map(
    (item, i) => `
<button class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-[16px] rounded-xl row-press"
        data-action-index="${i}" style="${item.destructive ? 'color:var(--accent)' : ''}">
  ${item.icon ? `<span class="shrink-0" style="color:var(--muted)">${item.icon}</span>` : ''}
  <span>${escapeHtml(item.label)}</span>
</button>`,
  )
  .join('')}
<button class="w-full mt-2 py-3.5 text-[16px] font-semibold rounded-xl"
        style="background:var(--surface-3)" data-action-cancel>Cancel</button>`;

  sheet.classList.remove('hidden');
  requestAnimationFrame(() => panel.classList.remove('translate-y-full'));
}

function closeActionSheet(): void {
  const sheet = $('action-sheet');
  const panel = $('action-panel');
  panel?.classList.add('translate-y-full');
  setTimeout(() => sheet?.classList.add('hidden'), 280);
}

function bindActionSheet(): void {
  const sheet = $('action-sheet');
  if (!sheet || sheet.dataset.bound === '1') return;
  sheet.dataset.bound = '1';

  $('action-backdrop')?.addEventListener('click', closeActionSheet);
  $('action-panel')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action-cancel]')) {
      closeActionSheet();
      return;
    }
    const button = target.closest<HTMLElement>('[data-action-index]');
    if (!button) return;
    const item = actionHandlers[Number(button.dataset.actionIndex)];
    closeActionSheet();
    if (item) {
      void Promise.resolve(item.onSelect()).catch((error) => {
        showToast(error?.userMessage ?? 'That did not work.', 'error');
      });
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Store bindings                                                            */
/* ------------------------------------------------------------------------ */

function subscribeToStore(): void {
  if (document.body.dataset.playerBound === '1') return;
  document.body.dataset.playerBound = '1';

  // Track change: update text, artwork and the mini player's visibility.
  select(player.store, (s) => s.track, (track) => {
    updateTrackDisplay(track);
    if (queueOpen) renderQueue();
    markPlayingRows();
  }, { immediate: true });

  // Play/pause icons.
  select(player.store, (s) => s.status, (status) => {
    const playing = status === 'playing' || status === 'loading';
    const icon = playing ? icons.pause(24) : icons.play(24);
    const miniPlay = $('mini-play');
    if (miniPlay) {
      miniPlay.innerHTML = icon;
      miniPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    const npPlay = $('np-play');
    if (npPlay) {
      npPlay.innerHTML = playing ? icons.pause(30) : icons.play(30);
      npPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    document.querySelectorAll('.eq').forEach((eq) => eq.classList.toggle('is-paused', !playing));

    if (status === 'error') {
      const error = player.store.get().error;
      if (error) showToast(error.userMessage, 'error');
    }
  }, { immediate: true });

  // Progress. This is the highest-frequency update, so it touches only the
  // few nodes that actually show time.
  select(player.store, (s) => Math.floor(s.currentTime), () => updateProgress());
  select(player.store, (s) => s.duration, () => updateProgress());

  // Shuffle / repeat button states.
  select(player.store, (s) => s.queue.shuffle, (shuffle) => {
    const btn = $('np-shuffle');
    if (!btn) return;
    btn.style.color = shuffle ? 'var(--accent)' : 'var(--muted)';
    btn.setAttribute('aria-pressed', String(shuffle));
  }, { immediate: true });

  select(player.store, (s) => s.queue.repeat, (repeat) => {
    const btn = $('np-repeat');
    if (!btn) return;
    btn.innerHTML = repeat === 'one' ? icons.repeatOne(20) : icons.repeat(20);
    btn.style.color = repeat === 'off' ? 'var(--muted)' : 'var(--accent)';
    btn.setAttribute('aria-label', `Repeat: ${repeat}`);
  }, { immediate: true });

  select(player.store, (s) => `${s.volume}:${s.muted}`, () => {
    const volume = $<HTMLInputElement>('np-volume');
    const { volume: v, muted } = player.store.get();
    if (volume) {
      volume.value = String(Math.round(v * 100));
      volume.style.setProperty('--progress', `${v * 100}%`);
    }
    const mute = $('np-mute');
    if (mute) mute.innerHTML = muted || v === 0 ? icons.volumeOff(17) : icons.volume(17);
  }, { immediate: true });
}

function updateTrackDisplay(track: Track | null): void {
  const mini = $('mini-player');
  if (!track) {
    mini?.classList.add('mini-hidden');
    return;
  }
  mini?.classList.remove('mini-hidden');

  const artist = trackArtistName(track);
  setText('mini-title', track.title);
  setText('mini-artist', artist);
  setText('np-title', track.title);
  setText('np-artist', artist);

  const artistLink = $<HTMLAnchorElement>('np-artist');
  if (artistLink) {
    if (track.artist_id) {
      artistLink.href = `/artist?id=${encodeURIComponent(track.artist_id)}`;
      artistLink.onclick = () => closeNowPlaying();
    } else {
      artistLink.removeAttribute('href');
    }
  }

  void artworkUrl(trackArtwork(track)).then((url) => {
    // Guard: the user may have skipped on while this resolved.
    if (player.store.get().track?.id !== track.id) return;
    for (const id of ['mini-art', 'np-art']) {
      const img = $<HTMLImageElement>(id);
      if (img) {
        img.src = url;
        img.classList.add('is-loaded');
      }
    }
  });

  markPlayingRows();
}

function updateProgress(): void {
  const { currentTime, duration, seeking } = player.store.get();
  const ratio = duration > 0 ? currentTime / duration : 0;

  const miniProgress = $('mini-progress');
  if (miniProgress) miniProgress.style.width = `${ratio * 100}%`;

  if (!seeking) {
    const scrub = $<HTMLInputElement>('np-scrub');
    if (scrub) {
      scrub.value = String(Math.round(ratio * 1000));
      scrub.style.setProperty('--progress', `${ratio * 100}%`);
    }
    setText('np-elapsed', formatDuration(currentTime));
  }
  setText('np-remaining', duration > 0 ? `-${formatDuration(duration - currentTime)}` : '--:--');
}

/** Highlights whichever visible row corresponds to the current track. */
export function markPlayingRows(): void {
  const currentId = player.store.get().track?.id;
  const playing = player.store.get().status === 'playing';

  document.querySelectorAll<HTMLElement>('.track-row').forEach((row) => {
    const isCurrent = row.dataset.trackId === currentId;
    row.classList.toggle('is-playing-row', isCurrent);

    const title = row.querySelector<HTMLElement>('[data-title]');
    if (title) title.style.color = isCurrent ? 'var(--accent)' : '';

    // Swap the track number for an equaliser on the active row.
    const indexCell = row.querySelector<HTMLElement>('[data-track-index]');
    if (indexCell) {
      if (isCurrent) {
        if (!indexCell.dataset.originalIndex) {
          indexCell.dataset.originalIndex = indexCell.textContent ?? '';
        }
        indexCell.innerHTML = `<span class="eq${playing ? '' : ' is-paused'}"><span></span><span></span><span></span></span>`;
      } else if (indexCell.dataset.originalIndex) {
        indexCell.textContent = indexCell.dataset.originalIndex;
      }
    }
  });
}

function setText(id: string, value: string): void {
  const el = $(id);
  if (el) el.textContent = value;
}

export { openNowPlaying, closeNowPlaying };
