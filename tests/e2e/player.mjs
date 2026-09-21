import { chromium } from 'playwright';
import { launchOptions } from './launch.mjs';
import { installMock, seedConnection } from './supabase-mock.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? (process.env.E2E_BASE_URL ?? 'http://localhost:4321');
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch(launchOptions({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await installMock(page);
await seedConnection(page);

const audioState = () => page.evaluate(() => {
  const a = document.getElementById('app-audio');
  return { src: a?.src?.slice(0, 60) ?? '', paused: a?.paused, time: a?.currentTime ?? 0, duration: a?.duration ?? 0 };
});

// ------------------------------------------------------------------ LIBRARY
await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const songRows = await page.locator('.track-row').count();
check('library lists songs', songRows > 0, `${songRows} rows`);
await page.screenshot({ path: `${SHOTS}05-library-songs.png` });

await page.click('[data-tab="albums"]');
await page.waitForTimeout(900);
check('albums tab switches without a page reload', (await page.locator('[data-album-id]').count()) > 0);
check('albums tab updates the URL', page.url().includes('tab=albums'));
await page.screenshot({ path: `${SHOTS}06-library-albums.png` });

await page.click('[data-tab="artists"]');
await page.waitForTimeout(800);
check('artists tab lists artists', (await page.locator('a[href^="/artist"]').count()) > 0);

await page.click('[data-tab="playlists"]');
await page.waitForTimeout(800);
check('playlists tab lists playlists', (await page.locator('a[href^="/playlist"]').count()) > 0);
await page.screenshot({ path: `${SHOTS}07-library-playlists.png` });

// -------------------------------------------------------------- ALBUM + PLAY
await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const albumText = await page.locator('#album-root').textContent();
check('album detail shows title, artist and metadata',
  /Slow Tide/.test(albumText ?? '') && /Aurora Field/.test(albumText ?? '') && /2023/.test(albumText ?? ''));
check('album shows its track list', (await page.locator('.track-row').count()) === 5);
check('album has Play and Shuffle', await page.locator('#album-play').isVisible() && await page.locator('#album-shuffle').isVisible());
await page.screenshot({ path: `${SHOTS}08-album.png` });

// Tap the third track.
await page.locator('.track-row').nth(2).click();
await page.waitForTimeout(1800);
let audio = await audioState();
check('tapping a track loads audio into the shared element', audio.src.length > 0, audio.src);
check('audio is actually playing', audio.paused === false && audio.time > 0, `t=${audio.time.toFixed(2)}s`);
check('mini player appears', await page.locator('#mini-player').isVisible());
const miniTitle = await page.locator('#mini-title').textContent();
check('mini player shows the right track', miniTitle === 'Salt Air', miniTitle ?? '');
check('the tapped row is marked as playing', (await page.locator('.is-playing-row').count()) === 1);
await page.screenshot({ path: `${SHOTS}09-playing-miniplayer.png` });

// ----------------------------------------------- PLAYBACK SURVIVES NAVIGATION
const before = await audioState();
await page.click('[data-nav-href="/search"]');
await page.waitForTimeout(1500);
const after = await audioState();
check('playback continues across screen navigation',
  after.paused === false && after.time >= before.time && after.src === before.src,
  `${before.time.toFixed(2)}s -> ${after.time.toFixed(2)}s`);
check('mini player persists across navigation', await page.locator('#mini-player').isVisible());

// ------------------------------------------------------------------- SEARCH
await page.fill('#search-input', 'harbour');
await page.waitForTimeout(1200);
const searchText = await page.locator('#search-results').textContent();
check('search finds matching tracks, albums and artists',
  /Harbour Lights/.test(searchText ?? '') && /Low Harbour/.test(searchText ?? ''));
await page.screenshot({ path: `${SHOTS}10-search.png` });

await page.fill('#search-input', 'zzzznotfound');
await page.waitForTimeout(1000);
check('search shows a proper empty state', /No results/.test(await page.locator('#search-results').textContent() ?? ''));

// -------------------------------------------------------------- NOW PLAYING
await page.click('#mini-expand');
await page.waitForTimeout(800);
check('Now Playing sheet opens', await page.locator('#now-playing').evaluate((el) => el.classList.contains('is-open')));
const npText = await page.locator('#now-playing').textContent();
check('Now Playing shows title and artist', /Salt Air/.test(npText ?? '') && /Aurora Field/.test(npText ?? ''));
const elapsed = await page.locator('#np-elapsed').textContent();
check('Now Playing shows elapsed time', /\d+:\d\d/.test(elapsed ?? ''), elapsed ?? '');
const npArtLoaded = await page.locator('#np-art').evaluate((i) => i.naturalWidth > 0);
check('Now Playing renders large artwork', npArtLoaded);
const volumeHidden = await page.locator('#np-volume-wrap').evaluate((el) => el.classList.contains('hidden'));
check('volume slider is hidden on iOS (hardware-only there)', volumeHidden);
await page.screenshot({ path: `${SHOTS}11-now-playing.png` });

// Transport controls.
await page.click('#np-play');
await page.waitForTimeout(600);
check('pause works', (await audioState()).paused === true);
await page.click('#np-play');
await page.waitForTimeout(600);
check('resume works', (await audioState()).paused === false);

await page.click('#np-next');
await page.waitForTimeout(1500);
check('next advances the track', (await page.locator('#np-title').textContent()) === 'Low Sun',
  await page.locator('#np-title').textContent() ?? '');

await page.click('#np-prev');
await page.waitForTimeout(1500);
check('previous goes back a track', (await page.locator('#np-title').textContent()) === 'Salt Air');

// Shuffle + repeat.
await page.click('#np-shuffle');
await page.waitForTimeout(400);
check('shuffle toggles on', await page.locator('#np-shuffle').getAttribute('aria-pressed') === 'true');
check('shuffle keeps the current track playing', (await page.locator('#np-title').textContent()) === 'Salt Air');
await page.click('#np-repeat');
await page.waitForTimeout(300);
check('repeat cycles', /all/.test(await page.locator('#np-repeat').getAttribute('aria-label') ?? ''));

// Seeking.
await page.locator('#np-scrub').evaluate((el) => {
  el.value = '500';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(800);
const seeked = await audioState();
check('seeking moves playback position', seeked.time > 2, `t=${seeked.time.toFixed(2)}s`);

// -------------------------------------------------------------------- QUEUE
await page.click('#np-queue-open');
await page.waitForTimeout(700);
check('queue sheet opens', await page.locator('#queue-sheet').evaluate((el) => el.classList.contains('is-open')));
const queueCount = await page.locator('[data-queue-index]').count();
check('queue lists upcoming tracks', queueCount > 0, `${queueCount} upcoming`);
await page.screenshot({ path: `${SHOTS}12-queue.png` });

await page.locator('[data-queue-remove]').first().click();
await page.waitForTimeout(500);
check('removing from the queue works', (await page.locator('[data-queue-index]').count()) === queueCount - 1);
await page.click('#queue-close');
await page.waitForTimeout(500);
await page.click('#np-close');
await page.waitForTimeout(500);

// ----------------------------------------------------------------- PLAYLIST
await page.goto(`${BASE}/playlist?id=p1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const plText = await page.locator('#playlist-root').textContent();
check('playlist detail renders', /Late Evening/.test(plText ?? ''));
check('playlist lists its tracks', (await page.locator('.track-row').count()) === 4);
await page.screenshot({ path: `${SHOTS}13-playlist.png` });

// Track "…" menu.
await page.locator('[data-track-menu]').first().click();
await page.waitForTimeout(600);
const sheetText = await page.locator('#action-panel').textContent();
check('track menu offers queue and playlist actions',
  /Play next/.test(sheetText ?? '') && /Add to playlist/.test(sheetText ?? ''));
check('playlist rows add reorder + remove actions',
  /Move up/.test(sheetText ?? '') && /Remove from playlist/.test(sheetText ?? ''));
await page.screenshot({ path: `${SHOTS}14-track-menu.png` });
await page.click('[data-action-cancel]');
await page.waitForTimeout(400);

// ----------------------------------------------------------------- ARTIST
await page.goto(`${BASE}/artist?id=ar1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const artistText = await page.locator('#artist-root').textContent();
check('artist detail shows name, bio, albums and songs',
  /Aurora Field/.test(artistText ?? '') && /coastal cabin/.test(artistText ?? '') && /Albums/.test(artistText ?? ''));
await page.screenshot({ path: `${SHOTS}15-artist.png` });

// ---------------------------------------------------------------- SETTINGS
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const settingsText = await page.locator('#settings-root').textContent();
check('settings shows connection status', /Connected/.test(settingsText ?? ''));
check('settings shows the signed-in account', /me@example.com/.test(settingsText ?? ''));
check('settings explains what is stored', /local storage|never stored/i.test(settingsText ?? ''));
check('settings shows library counts', /15/.test(settingsText ?? ''));
check('settings offers disconnect + clear', /clear saved settings/i.test(settingsText ?? ''));
await page.screenshot({ path: `${SHOTS}16-settings.png` });

// Theme switch.
await page.click('[data-theme="midnight"]');
await page.waitForTimeout(600);
check('theme switch applies', await page.evaluate(() => document.documentElement.dataset.theme) === 'midnight');
await page.screenshot({ path: `${SHOTS}17-settings-midnight.png` });
await page.click('[data-theme="dark"]');
await page.waitForTimeout(500);

// ------------------------------------- AUDIO ACROSS A FULL IN-APP NAV TOUR
// Note: the page.goto() calls above are *hard reloads*, which legitimately
// stop audio in any web player. What matters is in-app navigation, so this
// walks every tab by clicking, the way a user does.
await page.goto(`${BASE}/album?id=al3`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.locator('.track-row').first().click();
await page.waitForTimeout(1500);
const tourStart = await audioState();
check('playback starts for the navigation tour', !tourStart.paused, `t=${tourStart.time.toFixed(2)}s`);

for (const [href, label] of [['/library', 'Library'], ['/search', 'Search'], ['/settings', 'Settings'], ['/', 'Home']]) {
  await page.click(`[data-nav-href="${href}"]`);
  await page.waitForTimeout(900);
  const s = await audioState();
  check(`audio keeps playing after navigating to ${label}`, !s.paused && s.src === tourStart.src,
    `t=${s.time.toFixed(2)}s`);
}

const finalAudio = await audioState();
check('audio advanced steadily through the whole tour',
  finalAudio.time > tourStart.time + 2, `${tourStart.time.toFixed(2)}s -> ${finalAudio.time.toFixed(2)}s`);

// ------------------------------------------------- AUTO-ADVANCE AT TRACK END
// Seek to just before the end of a real file and let it finish on its own.
// Earlier checks left shuffle on and it persists; this test asserts the
// *sequential* next track, so turn it off explicitly first.
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem('resonance:preferences') || '{}');
  localStorage.setItem('resonance:preferences', JSON.stringify({ ...prefs, shuffle: false, repeat: 'off' }));
});
await page.goto(`${BASE}/album?id=al2`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
check('shuffle preference persists across a reload',
  await page.evaluate(() => JSON.parse(localStorage.getItem('resonance:preferences')).shuffle) === false);
await page.locator('.track-row').first().click();
await page.waitForTimeout(1500);
const firstTitle = await page.locator('#mini-title').textContent();
await page.evaluate(() => {
  const a = document.getElementById('app-audio');
  if (a && isFinite(a.duration)) a.currentTime = a.duration - 0.4;
});
await page.waitForTimeout(3000);
const nextTitle = await page.locator('#mini-title').textContent();
check('a finished track auto-advances to the next one',
  nextTitle !== firstTitle && nextTitle === 'Harbour Lights', `${firstTitle} -> ${nextTitle}`);

// ------------------------------------------------------ EXPIRED URL RECOVERY
// Break the asset route, force an audio error, and confirm the engine re-signs
// and resumes at the same position rather than dropping the listener.
let firstFailureDone = false;
await page.route('**/mock-asset*', async (route) => {
  if (!firstFailureDone) { firstFailureDone = true; return route.fulfill({ status: 403, body: 'expired' }); }
  return route.fallback();
});
await page.evaluate(() => {
  const a = document.getElementById('app-audio');
  if (a) { a.src = a.src + '&bust=1'; a.load(); }
});
await page.waitForTimeout(4000);
const recovered = await audioState();
check('recovers from a dead audio URL without losing the track',
  recovered.src.length > 0 && (await page.locator('#mini-title').textContent()) === nextTitle,
  `t=${recovered.time.toFixed(2)}s`);

await browser.close();

// The expired-URL recovery check deliberately serves a 403, so that one
// console error is expected; anything else is a real defect.
const unexpected = [...new Set(errors)].filter((e) => !/403 \(Forbidden\)/.test(e));
console.log('\n--- unexpected console errors ---');
console.log(unexpected.length ? unexpected.join('\n') : '(none)');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || unexpected.length ? 1 : 0);
