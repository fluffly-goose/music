/**
 * HTML builders shared by every screen.
 *
 * Screens render by assigning innerHTML from these functions and then binding
 * one delegated click handler at the container level. Everything user-supplied
 * goes through escapeHtml.
 */

import { escapeHtml, formatDuration, pluralize } from '../utils/format';
import { placeholderArtwork } from '../library/artwork';
import { icons } from './icons';
import type { Album, Artist, Playlist, Track } from '../library/types';
import { trackArtistName } from '../library/types';

/**
 * An <img> that hydrateArtwork() will later fill with a signed URL.
 * Starts on the deterministic placeholder so nothing pops in from blank.
 */
export function artworkImg(
  path: string | null,
  seed: string,
  options: { className?: string; sizes?: string } = {},
): string {
  const cls = options.className ?? 'w-full h-full';
  return (
    `<img class="artwork ${cls}" alt="" loading="lazy" decoding="async" ` +
    `src="${placeholderArtwork(seed)}" ` +
    (path ? `data-art-path="${escapeHtml(path)}" ` : '') +
    `data-art-seed="${escapeHtml(seed)}">`
  );
}

/** One row in a track list. `index` shows a number instead of artwork. */
export function trackRow(
  track: Track,
  options: { index?: number; showArtwork?: boolean; playlistTrackId?: string; reorderable?: boolean } = {},
): string {
  const showArtwork = options.showArtwork ?? options.index === undefined;
  const leading = showArtwork
    ? `<div class="w-11 h-11 rounded-md overflow-hidden shrink-0">
         ${artworkImg(track.album?.cover_path ?? null, track.album?.title ?? track.title)}
       </div>`
    : `<div class="w-7 shrink-0 text-center text-[13px] tabular-nums" style="color:var(--subtle)"
         data-track-index>${options.index}</div>`;

  return `
<div class="track-row row-press flex items-center gap-3 px-4 py-2 cursor-pointer"
     data-track-id="${escapeHtml(track.id)}"
     ${options.playlistTrackId ? `data-playlist-track-id="${escapeHtml(options.playlistTrackId)}"` : ''}
     role="button" tabindex="0"
     aria-label="Play ${escapeHtml(track.title)} by ${escapeHtml(trackArtistName(track))}">
  ${leading}
  <div class="min-w-0 flex-1">
    <div class="text-[15px] leading-tight truncate" data-title>${escapeHtml(track.title)}</div>
    <div class="text-[13px] truncate mt-0.5" style="color:var(--muted)">
      ${escapeHtml(trackArtistName(track))}
    </div>
  </div>
  <div class="text-[13px] tabular-nums shrink-0" style="color:var(--subtle)">
    ${formatDuration(track.duration_seconds)}
  </div>
  <button class="tap shrink-0 -mr-2 track-menu" style="color:var(--subtle)"
          data-track-menu="${escapeHtml(track.id)}"
          aria-label="More options for ${escapeHtml(track.title)}">
    ${icons.more(18)}
  </button>
</div>`;
}

/** Square album tile used in shelves and grids. */
export function albumTile(album: Album, options: { wide?: boolean } = {}): string {
  const subtitle = album.artist?.name ?? (album.year ? String(album.year) : '');
  return `
<a href="/album?id=${encodeURIComponent(album.id)}"
   class="block group" data-album-id="${escapeHtml(album.id)}">
  <div class="aspect-square rounded-[10px] overflow-hidden tile-shadow ${options.wide ? '' : ''}">
    ${artworkImg(album.cover_path, album.title)}
  </div>
  <div class="mt-2 text-[13px] font-medium leading-tight truncate">${escapeHtml(album.title)}</div>
  ${subtitle ? `<div class="text-[12px] truncate" style="color:var(--muted)">${escapeHtml(subtitle)}</div>` : ''}
</a>`;
}

/** Track tile for the "Recently played" shelf. */
export function trackTile(track: Track): string {
  return `
<div class="block cursor-pointer" data-track-id="${escapeHtml(track.id)}" data-tile-track role="button" tabindex="0">
  <div class="aspect-square rounded-[10px] overflow-hidden tile-shadow">
    ${artworkImg(track.album?.cover_path ?? null, track.album?.title ?? track.title)}
  </div>
  <div class="mt-2 text-[13px] font-medium leading-tight truncate">${escapeHtml(track.title)}</div>
  <div class="text-[12px] truncate" style="color:var(--muted)">${escapeHtml(trackArtistName(track))}</div>
</div>`;
}

export function artistRow(artist: Artist): string {
  return `
<a href="/artist?id=${encodeURIComponent(artist.id)}"
   class="row-press flex items-center gap-3 px-4 py-2.5">
  <div class="w-12 h-12 rounded-full overflow-hidden shrink-0">
    ${artworkImg(artist.image_path, artist.name)}
  </div>
  <div class="flex-1 min-w-0 text-[15px] truncate">${escapeHtml(artist.name)}</div>
  <span style="color:var(--subtle)">${icons.chevronRight(18)}</span>
</a>`;
}

export function albumRow(album: Album): string {
  return `
<a href="/album?id=${encodeURIComponent(album.id)}"
   class="row-press flex items-center gap-3 px-4 py-2">
  <div class="w-12 h-12 rounded-md overflow-hidden shrink-0">
    ${artworkImg(album.cover_path, album.title)}
  </div>
  <div class="flex-1 min-w-0">
    <div class="text-[15px] truncate">${escapeHtml(album.title)}</div>
    <div class="text-[13px] truncate" style="color:var(--muted)">
      ${escapeHtml(album.artist?.name ?? 'Unknown Artist')}
    </div>
  </div>
  <span style="color:var(--subtle)">${icons.chevronRight(18)}</span>
</a>`;
}

export function playlistRow(playlist: Playlist): string {
  return `
<a href="/playlist?id=${encodeURIComponent(playlist.id)}"
   class="row-press flex items-center gap-3 px-4 py-2">
  <div class="w-12 h-12 rounded-md overflow-hidden shrink-0">
    ${artworkImg(playlist.cover_path, playlist.name)}
  </div>
  <div class="flex-1 min-w-0">
    <div class="text-[15px] truncate">${escapeHtml(playlist.name)}</div>
    <div class="text-[13px]" style="color:var(--muted)">
      ${pluralize(playlist.track_count ?? 0, 'song')}
    </div>
  </div>
  <span style="color:var(--subtle)">${icons.chevronRight(18)}</span>
</a>`;
}

export function sectionHeader(title: string, href?: string): string {
  return `
<div class="flex items-baseline justify-between px-4 mb-3">
  <h2 class="text-[21px] font-bold tracking-tight">${escapeHtml(title)}</h2>
  ${href ? `<a href="${href}" class="text-[14px]" style="color:var(--accent)">See all</a>` : ''}
</div>`;
}

/* ---------------------------------------------------------------------------
   Loading / empty / error states.
   Section 11 of the brief: no blank screens, ever.
   --------------------------------------------------------------------------- */

export function skeletonShelf(count = 4): string {
  return `<div class="shelf">${Array.from({ length: count }, () =>
    `<div><div class="skeleton aspect-square"></div>
     <div class="skeleton h-3 mt-2 w-3/4"></div>
     <div class="skeleton h-3 mt-1.5 w-1/2"></div></div>`,
  ).join('')}</div>`;
}

export function skeletonRows(count = 6): string {
  return `<div class="px-4 space-y-3">${Array.from({ length: count }, () =>
    `<div class="flex items-center gap-3">
       <div class="skeleton w-11 h-11 shrink-0"></div>
       <div class="flex-1"><div class="skeleton h-3.5 w-2/3"></div>
       <div class="skeleton h-3 mt-2 w-1/3"></div></div>
     </div>`,
  ).join('')}</div>`;
}

export function emptyState(
  title: string,
  body: string,
  action?: { label: string; href?: string; id?: string },
): string {
  return `
<div class="flex flex-col items-center text-center px-8 py-16">
  <div class="mb-4" style="color:var(--subtle)">${icons.music(44)}</div>
  <h3 class="text-[17px] font-semibold">${escapeHtml(title)}</h3>
  <p class="text-[14px] mt-2 max-w-xs leading-relaxed" style="color:var(--muted)">${escapeHtml(body)}</p>
  ${
    action
      ? action.href
        ? `<a href="${action.href}" class="btn-accent mt-6 px-5 py-2.5 text-[14px]">${escapeHtml(action.label)}</a>`
        : `<button id="${action.id ?? ''}" class="btn-accent mt-6 px-5 py-2.5 text-[14px]">${escapeHtml(action.label)}</button>`
      : ''
  }
</div>`;
}

export function errorState(
  message: string,
  hint?: string,
  action?: { label: string; id: string },
): string {
  return `
<div class="flex flex-col items-center text-center px-8 py-16">
  <div class="mb-4" style="color:var(--accent)">${icons.warning(40)}</div>
  <h3 class="text-[17px] font-semibold">${escapeHtml(message)}</h3>
  ${hint ? `<p class="text-[14px] mt-2 max-w-sm leading-relaxed" style="color:var(--muted)">${escapeHtml(hint)}</p>` : ''}
  ${action ? `<button id="${action.id}" class="btn-ghost mt-6 px-5 py-2.5 text-[14px]">${escapeHtml(action.label)}</button>` : ''}
</div>`;
}

/** Non-blocking toast for confirmations and recoverable failures. */
export function showToast(message: string, variant: 'info' | 'error' = 'info'): void {
  const existing = document.getElementById('app-toast');
  existing?.remove();

  const el = document.createElement('div');
  el.id = 'app-toast';
  el.setAttribute('role', 'status');
  el.className =
    'fixed left-1/2 -translate-x-1/2 z-[80] px-4 py-2.5 rounded-full text-[14px] ' +
    'max-w-[90vw] text-center transition-opacity duration-300 pointer-events-none';
  el.style.bottom = 'calc(var(--chrome-height) + 4.75rem)';
  el.style.background = variant === 'error' ? 'var(--accent)' : 'var(--surface-3)';
  el.style.color = '#fff';
  el.style.boxShadow = '0 8px 30px -8px rgb(0 0 0 / .8)';
  el.textContent = message;
  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}
