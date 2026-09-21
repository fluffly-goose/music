/**
 * Delegated handlers for track lists.
 *
 * Every screen showing tracks calls bindTrackList() once with the tracks it
 * rendered; taps, keyboard activation and the "…" menu are then handled here
 * rather than re-implemented per screen.
 */

import { player } from '../player/engine';
import { library } from '../library/service';
import { connection } from '../connection/manager';
import type { Track } from '../library/types';
import { openActionSheet, type ActionItem } from './player-ui';
import { showToast } from './render';
import { icons } from './icons';
import { escapeHtml } from '../utils/format';

export interface TrackListOptions {
  /** The tracks in the order they appear, so tapping row N starts at N. */
  tracks: () => Track[];
  /** Called after an edit or delete, so the screen can reload. */
  onChanged?: () => void | Promise<void>;
  /** Extra items for the "…" menu, e.g. "Remove from this playlist". */
  extraActions?: (track: Track, row: HTMLElement) => {
    label: string;
    icon?: string;
    destructive?: boolean;
    onSelect: () => void | Promise<void>;
  }[];
}

export function bindTrackList(root: HTMLElement, options: TrackListOptions): void {
  const activate = (row: HTMLElement) => {
    const tracks = options.tracks();
    const index = tracks.findIndex((t) => t.id === row.dataset.trackId);
    if (index >= 0) void player.playTracks(tracks, { startIndex: index });
  };

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const menuButton = target.closest<HTMLElement>('[data-track-menu]');
    if (menuButton) {
      e.preventDefault();
      e.stopPropagation();
      const row = menuButton.closest<HTMLElement>('[data-track-id]');
      const track = options.tracks().find((t) => t.id === menuButton.dataset.trackMenu);
      if (track && row) showTrackMenu(track, row, options);
      return;
    }

    const row = target.closest<HTMLElement>('[data-track-id]');
    if (row) activate(row);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-track-id]');
    if (!row) return;
    e.preventDefault();
    activate(row);
  });
}

function showTrackMenu(track: Track, row: HTMLElement, options: TrackListOptions): void {
  const actions: ActionItem[] = [
    {
      label: 'Play next',
      icon: icons.next(19),
      onSelect: () => {
        player.playNext([track]);
        showToast('Playing next');
      },
    },
    {
      label: 'Add to queue',
      icon: icons.queue(19),
      onSelect: () => {
        player.enqueue([track]);
        showToast('Added to queue');
      },
    },
    {
      label: 'Add to playlist…',
      icon: icons.plus(19),
      onSelect: () => void promptAddToPlaylist(track),
    },
  ];

  actions.push({
    label: 'Edit details',
    icon: icons.edit(19),
    onSelect: async () => {
      const { editTrack } = await import('./edit-actions');
      await editTrack(track, options.onChanged);
    },
  });

  if (track.album_id) {
    actions.push({
      label: 'Go to album',
      icon: icons.music(19),
      onSelect: () => { window.location.href = `/album?id=${encodeURIComponent(track.album_id!)}`; },
    });
  }
  if (track.artist_id) {
    actions.push({
      label: 'Go to artist',
      icon: icons.chevronRight(19),
      onSelect: () => { window.location.href = `/artist?id=${encodeURIComponent(track.artist_id!)}`; },
    });
  }

  actions.push(...(options.extraActions?.(track, row) ?? []));
  openActionSheet(track.title, actions);
}

/** Second-level sheet listing the user's playlists, plus "New playlist". */
export async function promptAddToPlaylist(track: Track): Promise<void> {
  if (!connection.getOwnerId()) {
    showToast('Sign in to edit playlists', 'error');
    return;
  }

  let playlists;
  try {
    playlists = await library.getPlaylists();
  } catch (error) {
    showToast((error as { userMessage?: string }).userMessage ?? 'Could not load playlists', 'error');
    return;
  }

  const items = [
    {
      label: 'New playlist…',
      icon: icons.plus(19),
      onSelect: async () => {
        const name = window.prompt('Playlist name');
        if (!name?.trim()) return;
        const playlist = await library.createPlaylist(name.trim());
        await library.addTracksToPlaylist(playlist.id, [track.id]);
        showToast(`Added to ${playlist.name}`);
      },
    },
    ...playlists.map((playlist) => ({
      label: playlist.name,
      icon: icons.music(19),
      onSelect: async () => {
        await library.addTracksToPlaylist(playlist.id, [track.id]);
        showToast(`Added to ${playlist.name}`);
      },
    })),
  ];

  openActionSheet(`Add “${track.title}” to…`, items);
}

/** Shared header controls for albums and playlists. */
export function playAllButtons(idPrefix: string): string {
  return `
<div class="flex gap-2.5 px-4 mt-4">
  <button id="${idPrefix}-play" class="btn-accent flex-1 py-2.5 text-[15px] flex items-center justify-center gap-1.5">
    ${icons.play(17)} Play
  </button>
  <button id="${idPrefix}-shuffle" class="btn-ghost flex-1 py-2.5 text-[15px] flex items-center justify-center gap-1.5">
    ${icons.shuffle(16)} Shuffle
  </button>
</div>`;
}

export function bindPlayAll(idPrefix: string, tracks: () => Track[]): void {
  document.getElementById(`${idPrefix}-play`)?.addEventListener('click', () => {
    const list = tracks();
    if (list.length) void player.playTracks(list, { startIndex: 0, shuffle: false });
  });
  document.getElementById(`${idPrefix}-shuffle`)?.addEventListener('click', () => {
    const list = tracks();
    if (!list.length) return;
    const startIndex = Math.floor(Math.random() * list.length);
    void player.playTracks(list, { startIndex, shuffle: true });
  });
}

/** Large collection header used by album, artist and playlist screens. */
export function collectionHeader(options: {
  artPath: string | null;
  seed: string;
  title: string;
  subtitle: string;
  meta: string;
  round?: boolean;
  subtitleHref?: string;
}): string {
  const { artworkImg } = {
    artworkImg: (path: string | null, seed: string) =>
      `<img class="artwork w-full h-full" alt="" ${path ? `data-art-path="${escapeHtml(path)}"` : ''} data-art-seed="${escapeHtml(seed)}">`,
  };
  return `
<div class="flex flex-col items-center text-center px-6 pt-4">
  <div class="w-48 h-48 ${options.round ? 'rounded-full' : 'rounded-xl'} overflow-hidden tile-shadow">
    ${artworkImg(options.artPath, options.seed)}
  </div>
  <h1 class="text-[22px] font-bold tracking-tight mt-4 leading-tight">${escapeHtml(options.title)}</h1>
  ${
    options.subtitle
      ? options.subtitleHref
        ? `<a href="${options.subtitleHref}" class="text-[15px] mt-1" style="color:var(--accent)">${escapeHtml(options.subtitle)}</a>`
        : `<p class="text-[15px] mt-1" style="color:var(--accent)">${escapeHtml(options.subtitle)}</p>`
      : ''
  }
  <p class="text-[12px] mt-1.5 uppercase tracking-wide" style="color:var(--muted)">${escapeHtml(options.meta)}</p>
</div>`;
}
