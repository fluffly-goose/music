/**
 * Resolves artwork paths to signed URLs and paints a deterministic gradient
 * placeholder when a record has no cover. Artwork loads lazily and in batches
 * so opening Library does not fan out into one request per tile.
 */

import { connection } from '../connection/manager';
import { signedUrls } from '../player/urls';
import { hueFromString, initials, escapeHtml } from '../utils/format';
import type { Artwork } from './types';

/** Inline SVG data URI - no network, no layout shift, stable colour per title. */
export function placeholderArtwork(seed: string): string {
  const hue = hueFromString(seed || 'untitled');
  const letter = escapeHtml(initials(seed || '?'));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="hsl(${hue} 55% 42%)"/>
<stop offset="100%" stop-color="hsl(${(hue + 48) % 360} 60% 22%)"/>
</linearGradient></defs>
<rect width="300" height="300" fill="url(#g)"/>
<text x="150" y="150" font-family="system-ui,-apple-system,sans-serif" font-size="132"
 font-weight="600" fill="rgba(255,255,255,.82)" text-anchor="middle"
 dominant-baseline="central">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Signed URL for one artwork path, or the placeholder if unavailable. */
export async function artworkUrl(artwork: Artwork): Promise<string> {
  if (!artwork.path) return placeholderArtwork(artwork.seed);
  const client = connection.getClient();
  if (!client) return placeholderArtwork(artwork.seed);
  try {
    return await signedUrls.get(client, connection.getBucket(), artwork.path);
  } catch {
    // Missing artwork must never break a screen.
    return placeholderArtwork(artwork.seed);
  }
}

/**
 * Hydrates every `<img data-art-path>` inside a root element in one batched
 * sign request. Elements without a path get their placeholder immediately.
 */
export async function hydrateArtwork(root: ParentNode = document): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>('img[data-art-path]')];
  if (images.length === 0) return;

  const client = connection.getClient();
  const pending: HTMLImageElement[] = [];

  for (const img of images) {
    const path = img.dataset.artPath ?? '';
    const seed = img.dataset.artSeed ?? '';
    img.removeAttribute('data-art-path');
    if (!path || !client) {
      img.src = placeholderArtwork(seed);
      img.classList.add('is-loaded');
      continue;
    }
    const cached = signedUrls.peek(connection.getBucket(), path);
    if (cached) {
      img.src = cached;
      img.classList.add('is-loaded');
    } else {
      img.dataset.pendingPath = path;
      pending.push(img);
    }
  }

  if (pending.length === 0 || !client) return;

  try {
    const paths = pending.map((img) => img.dataset.pendingPath!).filter(Boolean);
    const urls = await signedUrls.getMany(client, connection.getBucket(), paths);
    for (const img of pending) {
      const path = img.dataset.pendingPath!;
      img.src = urls.get(path) ?? placeholderArtwork(img.dataset.artSeed ?? '');
      img.classList.add('is-loaded');
      delete img.dataset.pendingPath;
    }
  } catch {
    for (const img of pending) {
      img.src = placeholderArtwork(img.dataset.artSeed ?? '');
      img.classList.add('is-loaded');
      delete img.dataset.pendingPath;
    }
  }
}
