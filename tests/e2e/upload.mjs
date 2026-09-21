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

/** A real, parseable MP3 with ID3v2.3 tags. */
function makeMp3({ title, artist, album, track, year, genre, seconds = 4 }) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const ss = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const frames = Buffer.concat([
    title && frame('TIT2', title), artist && frame('TPE1', artist), album && frame('TALB', album),
    track && frame('TRCK', String(track)), year && frame('TYER', String(year)), genre && frame('TCON', genre),
  ].filter(Boolean));
  const tag = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), ss(frames.length), frames]);
  const FR = 417, count = Math.round((seconds * 44100) / 1152);
  const audio = Buffer.alloc(FR * count);
  for (let i = 0; i < count; i++) { const o = i * FR; audio[o] = 0xff; audio[o+1] = 0xfb; audio[o+2] = 0x90; }
  return Buffer.concat([tag, audio]);
}

const uploaded = [];
const inserted = [];

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await installMock(page, { uploaded, inserted });
await seedConnection(page);

// ------------------------------------------------------------------ discovery
await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
check('Library has an "Add music" entry point', await page.locator('a[href="/upload"]').count() > 0);

await page.goto(`${BASE}/upload`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
check('upload screen renders a drop zone', await page.locator('#dropzone').isVisible());
check('file input accepts multiple files', await page.locator('#file-input').getAttribute('multiple') !== null);
await page.screenshot({ path: `${SHOTS}24-upload-empty.png` });

// ------------------------------------------------------------ scan + review
await page.locator('#file-input').setInputFiles([
  { name: '01 Slow Tide.mp3', mimeType: 'audio/mpeg', buffer: makeMp3({ title: 'Slow Tide', artist: 'Aurora Field', album: 'Slow Tide', track: 1, year: 2023, genre: 'Ambient' }) },
  { name: '02 Driftwood.mp3', mimeType: 'audio/mpeg', buffer: makeMp3({ title: 'Driftwood', artist: 'Aurora Field', album: 'Slow Tide', track: 2, year: 2023, genre: 'Ambient' }) },
  { name: '01 Night Ferry.mp3', mimeType: 'audio/mpeg', buffer: makeMp3({ title: 'Night Ferry', artist: 'Low Harbour', album: 'Night Ferry', track: 1, year: 2022 }) },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') },
]);

await page.waitForSelector('#step-review:not(.hidden)', { timeout: 20000 });
const review = await page.locator('#step-review').textContent();

check('tags are read in the browser — titles shown', /Slow Tide/.test(review) && /Driftwood/.test(review) && /Night Ferry/.test(review));
check('tracks are grouped into their albums', /Aurora Field/.test(review) && /Low Harbour/.test(review));
check('durations are detected from the audio', /0:0\d/.test(review), (review.match(/0:0\d/) ?? [''])[0]);
check('the non-audio file is reported, not silently dropped', /notes\.txt/.test(review) && /skipped/i.test(review));
check('review shows a count before anything uploads', /3 tracks ready/.test(review));
check('nothing has been uploaded yet at the review step', uploaded.length === 0, `${uploaded.length} uploads`);
await page.screenshot({ path: `${SHOTS}25-upload-review.png`, fullPage: true });

// ----------------------------------------------------------------- uploading
await page.click('#btn-upload');
await page.waitForSelector('#step-done:not(.hidden)', { timeout: 30000 });
const done = await page.locator('#step-done').textContent();

check('import reports success', /All done/.test(done), done.replace(/\s+/g, ' ').slice(0, 70));
check('all three tracks were added', /3 tracks added/.test(done));
check('audio files were uploaded to storage', uploaded.filter((k) => k.endsWith('.mp3')).length === 3,
  `${uploaded.filter((k) => k.endsWith('.mp3')).length} audio objects`);

const ownerPrefixed = uploaded.every((k) => k.startsWith('11111111-1111-4111-8111-111111111111/'));
check('every object key starts with the owner id (what the Storage policy matches)', ownerPrefixed,
  uploaded[0] ?? '(none)');

const trackRows = inserted.filter((r) => r.table === 'tracks');
const albumRows = inserted.filter((r) => r.table === 'albums');
const artistRows = inserted.filter((r) => r.table === 'artists');
check('a row was written per track', trackRows.length === 3, `${trackRows.length} tracks`);

// The seeded library already has these artists and albums, so a correct
// importer reuses them rather than creating duplicates.
check('existing artists are reused, not duplicated', artistRows.length === 0, `${artistRows.length} created`);
check('existing albums are reused, not duplicated', albumRows.length === 0, `${albumRows.length} created`);
check('tracks are filed under the existing album', uploaded.some((k) => k.includes('/albums/al1/')),
  uploaded[0] ?? '(none)');

check('rows carry the owner id for RLS', trackRows.every((r) => r.row.owner_id === '11111111-1111-4111-8111-111111111111'));
check('track metadata was persisted', trackRows.some((r) => r.row.title === 'Driftwood' && r.row.track_no === 2));
check('durations were persisted', trackRows.every((r) => typeof r.row.duration_seconds === 'number'));

// ------------------------------------------------- a genuinely new album
const artistsBefore = artistRows.length;
await page.click('#btn-more');
await page.waitForTimeout(500);
await page.locator('#file-input').setInputFiles([
  { name: 'a.mp3', mimeType: 'audio/mpeg', buffer: makeMp3({ title: 'Opening', artist: 'Brand New Artist', album: 'Brand New Album', track: 1 }) },
  { name: 'b.mp3', mimeType: 'audio/mpeg', buffer: makeMp3({ title: 'Closing', artist: 'Brand New Artist', album: 'Brand New Album', track: 2 }) },
]);
await page.waitForSelector('#step-review:not(.hidden)', { timeout: 20000 });
await page.click('#btn-upload');
await page.waitForSelector('#step-done:not(.hidden)', { timeout: 30000 });

const newArtists = inserted.filter((r) => r.table === 'artists');
const newAlbums = inserted.filter((r) => r.table === 'albums');
check('a new artist is created exactly once for two of its tracks',
  newArtists.length - artistsBefore === 1, `${newArtists.length - artistsBefore} created`);
check('a new album is created exactly once for two of its tracks',
  newAlbums.length === 1, `${newAlbums.length} created`);
await page.screenshot({ path: `${SHOTS}26-upload-done.png` });

check('offers a route back into the library', await page.locator('a[href="/library"]').count() > 0);

// ------------------------------------------------------- unsupported format
const before = uploaded.length;
await page.click('#btn-more');
await page.waitForTimeout(500);
await page.locator('#file-input').setInputFiles([
  { name: 'track.flac', mimeType: 'audio/flac', buffer: makeMp3({ title: 'Flac Track', artist: 'A', album: 'B' }) },
]);
await page.waitForSelector('#step-review:not(.hidden)', { timeout: 20000 });
const flacReview = await page.locator('#step-review').textContent();
check('warns before upload that Safari cannot play FLAC', /Safari cannot play/i.test(flacReview));
check('the warning does not block the upload', await page.locator('#btn-upload').isEnabled());
check('still nothing uploaded while warning is shown', uploaded.length === before);
await page.screenshot({ path: `${SHOTS}27-upload-format-warning.png` });

await browser.close();
const unexpected = [...new Set(errors)];
console.log('\n--- unexpected console errors ---');
console.log(unexpected.length ? unexpected.join('\n') : '(none)');
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || unexpected.length ? 1 : 0);
