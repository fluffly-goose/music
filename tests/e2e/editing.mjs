import { chromium } from 'playwright';
import { launchOptions } from './launch.mjs';
import { installMock, seedConnection } from './supabase-mock.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4321';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const updated = [];
const inserted = [];
const deleted = [];

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.accept());           // confirm() for destructive actions

await installMock(page, { updated, inserted, deleted });
await seedConnection(page);

const fieldValue = (name) => page.inputValue(`#edit-${name}`);
const closeSheet = async () => {
  await page.click('.modal-header [data-close]');
  await page.waitForTimeout(500);
};

/* ----------------------------------------------------------------- album */
await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

check('album screen has an edit button', await page.locator('#album-edit').count() === 1);
await page.click('#album-edit');
await page.waitForSelector('.modal.is-open', { timeout: 10000 });

check('the sheet is pre-filled with current values',
  (await fieldValue('title')) === 'Slow Tide' && (await fieldValue('artist')) === 'Aurora Field',
  `${await fieldValue('title')} / ${await fieldValue('artist')}`);
check('year and genre come through too',
  (await fieldValue('year')) === '2023' && (await fieldValue('genre')) === 'Ambient');
check('artwork can be changed from the sheet', await page.locator('[data-art-picker]').count() === 1);
check('a delete action is offered, styled apart from the form',
  await page.locator('[data-danger]').count() === 1);
await page.screenshot({ path: `${SHOTS}33-edit-album.png` });

// Cancel must not save anything.
const before = updated.length;
await page.fill('#edit-title', 'Discarded Title');
await closeSheet();
check('cancelling discards the edit', updated.length === before);

// Now rename for real.
await page.click('#album-edit');
await page.waitForSelector('.modal.is-open');
await page.fill('#edit-title', 'Slow Tide (Remastered)');
await page.fill('#edit-year', '2024');
await page.click('[data-save]');
await page.waitForTimeout(1500);

const albumPatch = updated.find((u) => u.table === 'albums');
check('saving sends the new title', albumPatch?.patch?.title === 'Slow Tide (Remastered)',
  albumPatch?.patch?.title ?? '(none)');
check('and the new year, as a number not a string', albumPatch?.patch?.year === 2024,
  JSON.stringify(albumPatch?.patch?.year));
check('it patches the right row', albumPatch?.filters?.id === 'eq.al1');
check('the sheet closes after a successful save', await page.locator('.modal.is-open').count() === 0);

/* -------------------------------------------- album -> different artist */
await page.click('#album-edit');
await page.waitForSelector('.modal.is-open');
await page.fill('#edit-artist', 'Brand New Artist');
await page.click('[data-save]');
await page.waitForTimeout(1500);

const newArtist = inserted.find((r) => r.table === 'artists');
check('typing an unknown artist creates them', Boolean(newArtist), newArtist?.row?.name ?? '(none)');
const reassign = updated.filter((u) => u.table === 'albums').at(-1);
check('and the album is moved to that artist', Boolean(reassign?.patch?.artist_id));

/* ----------------------------------------------------------------- track */
await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('[data-track-menu]').first().click();
await page.waitForTimeout(700);
check('the track menu offers Edit details',
  /Edit details/.test(await page.locator('#action-panel').textContent() ?? ''));

await page.locator('#action-panel button', { hasText: 'Edit details' }).click();
await page.waitForSelector('.modal.is-open', { timeout: 10000 });
check('the song sheet is pre-filled', (await fieldValue('title')) === 'Slow Tide');
await page.screenshot({ path: `${SHOTS}34-edit-track.png` });

// Empty title must be rejected before any request goes out.
const beforeTrack = updated.length;
await page.fill('#edit-title', '   ');
await page.click('[data-save]');
await page.waitForTimeout(700);
check('an empty title is rejected inline', await page.locator('.form-error:not(.hidden)').count() === 1);
check('and nothing was saved', updated.length === beforeTrack);
check('the sheet stays open so the edit is not lost',
  await page.locator('.modal.is-open').count() === 1);

await page.fill('#edit-title', 'Slow Tide (Edit)');
await page.fill('#edit-track_no', '4');
await page.click('[data-save]');
await page.waitForTimeout(1500);

// Filter on the id filter: an album-wide artist cascade also patches `tracks`,
// but by album_id rather than by a single row.
const trackPatch = updated.find((u) => u.table === 'tracks' && u.filters?.id);
check('saving a song sends its new title', trackPatch?.patch?.title === 'Slow Tide (Edit)',
  String(trackPatch?.patch?.title ?? '(none)'));
check('numeric fields are saved as numbers', trackPatch?.patch?.track_no === 4,
  JSON.stringify(trackPatch?.patch?.track_no));

/* ---------------------------------------------------------------- artist */
await page.goto(`${BASE}/artist?id=ar1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('artist screen has an edit button', await page.locator('#artist-edit').count() === 1);
await page.click('#artist-edit');
await page.waitForSelector('.modal.is-open', { timeout: 10000 });

check('the artist sheet is pre-filled', (await fieldValue('name')) === 'Aurora Field');
const sheetText = await page.locator('.modal.is-open .modal-panel').textContent();
check('it warns that a rename applies everywhere',
  /Renaming updates this artist everywhere/i.test(sheetText ?? ''),
  (sheetText ?? '').replace(/\s+/g, ' ').match(/Renaming[^.]*\./)?.[0] ?? '');
check('the bio is editable', await page.locator('textarea#edit-bio').count() === 1);
await page.screenshot({ path: `${SHOTS}35-edit-artist.png` });

await page.fill('#edit-name', 'Aurora Fields');
await page.click('[data-save]');
await page.waitForTimeout(1500);
const artistPatch = updated.find((u) => u.table === 'artists');
check('saving renames the artist', artistPatch?.patch?.name === 'Aurora Fields');

/* --------------------------------------- moving ONE song to another artist */
{
  updated.length = 0; inserted.length = 0;
  await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('[data-track-menu]').nth(1).click();
  await page.waitForTimeout(700);
  await page.locator('#action-panel button', { hasText: 'Edit details' }).click();
  await page.waitForSelector('.modal.is-open', { timeout: 10000 });

  check('a song can be edited without leaving the album screen',
    await page.locator('#edit-artist').count() === 1 && await page.locator('#edit-album').count() === 1);
  check('the song sheet shows its current artist', (await fieldValue('artist')) === 'Aurora Field');
  check('and its current album', (await fieldValue('album')) === 'Slow Tide');
  await page.screenshot({ path: `${SHOTS}36-edit-song-move.png` });

  await page.fill('#edit-artist', 'Corrected Artist');
  await page.click('[data-save]');
  await page.waitForTimeout(2200);

  const trackPatch = updated.filter((u) => u.table === 'tracks').at(-1);
  check('changing one song\'s artist patches that song only',
    Boolean(trackPatch?.patch?.artist_id) && trackPatch?.filters?.id?.startsWith('eq.al1-t'),
    JSON.stringify(trackPatch?.filters ?? {}));
  check('the new artist is created on the fly',
    inserted.some((r) => r.table === 'artists' && r.row.name === 'Corrected Artist'));
}

/* ------------------------ changing an ALBUM's artist must move its songs */
{
  updated.length = 0; inserted.length = 0;
  await page.goto(`${BASE}/album?id=al3`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#album-edit');
  await page.waitForSelector('.modal.is-open');
  await page.fill('#edit-artist', 'Whole Album Artist');
  await page.click('[data-save]');
  await page.waitForTimeout(2200);

  const albumPatch = updated.find((u) => u.table === 'albums');
  check('the album is moved to the new artist', Boolean(albumPatch?.patch?.artist_id));

  // The regression this guards: tracks.artist_id is independent of
  // albums.artist_id, so without a cascade every song stays under the old one.
  const cascade = updated.find(
    (u) => u.table === 'tracks' && u.filters?.album_id === 'eq.al3',
  );
  check('and so is every song on it, by album_id in one update',
    Boolean(cascade) && Boolean(cascade.patch?.artist_id),
    JSON.stringify(cascade?.filters ?? {}));
}

/* --------------------------------------------------------------- artwork */
// Changing album art uploads under a NEW key: overwriting would leave cached
// signed URLs (and any CDN copy) serving the previous image.
{
  const uploaded = [];
  await installMock(page, { updated, inserted, deleted, uploaded });

  await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#album-edit');
  await page.waitForSelector('.modal.is-open');

  const pngBefore = await page.locator('[data-art-picker] img').getAttribute('src');
  await page.locator('[data-art-input]').setInputFiles({
    name: 'cover.png', mimeType: 'image/png',
    // 1x1 PNG
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'),
  });
  await page.waitForTimeout(600);
  const pngAfter = await page.locator('[data-art-picker] img').getAttribute('src');
  check('picking an image previews it immediately', pngBefore !== pngAfter);

  const uploadsBeforeSave = uploaded.length;
  check('but nothing is uploaded until you save', uploadsBeforeSave === 0, `${uploadsBeforeSave}`);

  await page.click('[data-save]');
  await page.waitForTimeout(2000);

  const coverUpload = uploaded.find((k) => k.includes('/albums/al1/cover-'));
  check('saving uploads the new artwork', Boolean(coverUpload), coverUpload ?? '(none)');
  check('under a fresh key, so cached URLs cannot serve the old image',
    Boolean(coverUpload) && !coverUpload.endsWith('/cover.jpg'), coverUpload ?? '');
  check('the key is owner-prefixed, as the Storage policy requires',
    Boolean(coverUpload?.startsWith('11111111-1111-4111-8111-111111111111/')));

  const coverPatch = updated.filter((u) => u.table === 'albums').at(-1);
  check('and the album row points at the new file',
    typeof coverPatch?.patch?.cover_path === 'string' && coverPatch.patch.cover_path.includes('cover-'),
    String(coverPatch?.patch?.cover_path ?? '(none)'));
}

/* ----------------------------------------------------- per-song artwork */
{
  const uploaded = [];
  updated.length = 0;
  await installMock(page, { updated, inserted, deleted, uploaded });

  await page.goto(`${BASE}/album?id=al2`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('[data-track-menu]').nth(1).click();
  await page.waitForTimeout(700);
  await page.locator('#action-panel button', { hasText: 'Edit details' }).click();
  await page.waitForSelector('.modal.is-open', { timeout: 10000 });

  check('a song can be given its own artwork', await page.locator('[data-art-picker]').count() === 1);
  await page.locator('[data-art-input]').setInputFiles({
    name: 'song.png', mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'),
  });
  await page.waitForTimeout(500);
  await page.click('[data-save]');
  await page.waitForTimeout(2000);

  const coverUpload = uploaded.find((k) => k.includes('/tracks/'));
  check('song artwork is stored under the song, not the album', Boolean(coverUpload),
    coverUpload ?? '(none)');
  check('and the key is owner-prefixed for the Storage policy',
    Boolean(coverUpload?.startsWith('11111111-1111-4111-8111-111111111111/')));

  const patch = updated.find((u) => u.table === 'tracks' && u.filters?.id);
  check('the song row points at its own cover',
    typeof patch?.patch?.cover_path === 'string' && patch.patch.cover_path.includes('/tracks/'),
    String(patch?.patch?.cover_path ?? '(none)'));
}

/* ------------------- a database without 0004 must still work, just without it */
{
  const older = await context.browser().newContext({ viewport: { width: 393, height: 852 } });
  const p2 = await older.newPage();
  const oops = [];
  p2.on('pageerror', (e) => oops.push(e.message));
  await installMock(p2);
  // Simulate the column not existing yet.
  await p2.route('**/rest/v1/tracks*', async (route) => {
    const url = new URL(route.request().url());
    if ((url.searchParams.get('select') ?? '') === 'cover_path') {
      return route.fulfill({
        status: 400, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ code: '42703', message: 'column tracks.cover_path does not exist' }),
      });
    }
    return route.fallback();
  });
  await seedConnection(p2);

  await p2.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1500);
  check('the library still loads without migration 0004',
    (await p2.locator('.track-row').count()) > 0,
    `${await p2.locator('.track-row').count()} rows`);

  await p2.locator('[data-track-menu]').first().click();
  await p2.waitForTimeout(700);
  await p2.locator('#action-panel button', { hasText: 'Edit details' }).click();
  await p2.waitForSelector('.modal.is-open', { timeout: 10000 });
  check('the song sheet still opens, just without the artwork picker',
    (await p2.locator('[data-art-picker]').count()) === 0);
  check('and it says how to enable it',
    /migration 0004/i.test(await p2.locator('.modal.is-open .modal-panel').textContent() ?? ''));
  check('no crash from the missing column', oops.length === 0, oops.join('; '));
  await p2.screenshot({ path: `${SHOTS}40-no-migration-0004.png` });
  await older.close();
}

/* ---------------------------------------------------------------- delete */
await page.goto(`${BASE}/album?id=al2`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('[data-track-menu]').first().click();
await page.waitForTimeout(700);
await page.locator('#action-panel button', { hasText: 'Edit details' }).click();
await page.waitForSelector('.modal.is-open');
await page.click('[data-danger]');
await page.waitForTimeout(1500);

const trackDelete = deleted.find((d) => d.table === 'tracks');
check('deleting a song removes its row', Boolean(trackDelete), JSON.stringify(trackDelete?.filters ?? {}));
check('the sheet closes after deleting', await page.locator('.modal.is-open').count() === 0);

await browser.close();
const unexpected = [...new Set(errors)];
console.log('\n--- unexpected console errors ---');
console.log(unexpected.length ? unexpected.join('\n') : '(none)');
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || unexpected.length ? 1 : 0);
