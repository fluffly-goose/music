/**
 * Runs on every page load (including Astro view-transition navigations).
 *
 * Order matters: the connection is restored first so screens can query
 * immediately, then the persistent player chrome is (re)bound, then the page's
 * own controller runs.
 */

import { connection } from '../connection/manager';
import { initPlayerUI } from './player-ui';
import { initGate, renderGate } from './gate';

let restoreStarted = false;

export function bootstrap(): void {
  initPlayerUI();
  highlightActiveTab();

  // Only once per document, not per navigation.
  if (!restoreStarted) {
    restoreStarted = true;
    initGate();
    void connection.restore();
    registerServiceWorker();
  }

  // After a view transition the persisted nodes stay, but the main region is
  // replaced - so rebind what belongs to the new page.
  document.addEventListener('astro:page-load', () => {
    initPlayerUI();
    highlightActiveTab();
  });

  // Astro swaps the DOM before page-load; make sure the gate is re-evaluated
  // against the new page's requiresConnection flag.
  document.addEventListener('astro:after-swap', () => {
    renderGate();
  });
}

function highlightActiveTab(): void {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll<HTMLAnchorElement>('[data-nav-href]').forEach((tab) => {
    const href = tab.dataset.navHref!;
    const active = href === '/' ? path === '/' : path.startsWith(href);
    tab.style.color = active ? 'var(--accent)' : 'var(--subtle)';
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

/**
 * Caches the app shell only. Audio is deliberately never cached - the brief
 * rules out an offline download system, and caching signed URLs would break
 * the moment they expire.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
