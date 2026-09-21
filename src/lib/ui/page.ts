/**
 * Every screen follows the same lifecycle: wait until the connection is
 * usable, show a skeleton, load, render, hydrate artwork, bind handlers.
 * `definePage` encodes that once so screens only supply the middle part.
 */

import { connection } from '../connection/manager';
import { hydrateArtwork } from '../library/artwork';
import { errorState } from './render';
import { markPlayingRows } from './player-ui';
import { AppError } from '../utils/errors';

/** Resolves as soon as the connection is usable; rejects if the user bails. */
export function whenConnected(): Promise<void> {
  return new Promise((resolve) => {
    if (connection.getState().status === 'connected') {
      resolve();
      return;
    }
    const off = connection.store.subscribe((state) => {
      if (state.status === 'connected') {
        off();
        resolve();
      }
    });
    // The gate dispatches this after a successful connect or sign-in.
    window.addEventListener('resonance:connected', () => { off(); resolve(); }, { once: true });
  });
}

export interface PageOptions {
  /** Element the screen renders into. */
  root: HTMLElement;
  /** Markup shown while loading. */
  skeleton?: string;
  /** Does the work and returns the screen's HTML. */
  load: () => Promise<string>;
  /** Runs after the HTML is in the DOM. */
  bind?: (root: HTMLElement) => void;
}

export async function definePage(options: PageOptions): Promise<void> {
  const { root, load, bind } = options;

  // A page's setup runs both on module evaluation and on astro:page-load, and
  // after a navigation every screen's listener fires. Marking the root element
  // makes setup idempotent: a fresh element (new navigation) is initialised,
  // an already-initialised one is left alone.
  if (root.dataset.pageInit === '1') return;
  root.dataset.pageInit = '1';

  if (options.skeleton) root.innerHTML = options.skeleton;

  await whenConnected();

  const render = async () => {
    try {
      root.innerHTML = await load();
      await hydrateArtwork(root);
      markPlayingRows();
      bind?.(root);
    } catch (raw) {
      const error = raw instanceof AppError ? raw : new AppError('unknown', String(raw));
      root.innerHTML = errorState(error.userMessage, error.hint, {
        label: 'Try again',
        id: 'page-retry',
      });
      document.getElementById('page-retry')?.addEventListener('click', () => void render());
    }
  };

  await render();
}

/** Reads a required `?id=` from the URL. */
export function requireQueryId(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}
