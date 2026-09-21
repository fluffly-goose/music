import { chromium } from 'playwright';
import { installMock, seedConnection, PROJECT, ANON_KEY, SESSION } from './supabase-mock.mjs';
import { mkdirSync } from 'node:fs';
import { launchOptions } from './launch.mjs';

const BASE = process.env.E2E_BASE_URL ?? (process.env.E2E_BASE_URL ?? 'http://localhost:4321');
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const browser = await chromium.launch(launchOptions());
const ctx = () => browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

/* -- 1. missing tables ---------------------------------------------------- */
{
  const c = await ctx(); const page = await c.newPage();
  await installMock(page);
  await page.route('**/demo.supabase.co/rest/v1/**', (r) => r.fulfill({
    status: 404, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ code: '42P01', message: 'relation "public.tracks" does not exist' }),
  }));
  await seedConnection(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const text = await page.locator('#connection-gate').textContent();
  check('missing tables → tells the user to run the migrations',
    /does not have the music tables|migrations/i.test(text ?? ''), (text ?? '').replace(/\s+/g,' ').match(/.{0,70}migrations.{0,30}/)?.[0] ?? '');
  await page.screenshot({ path: `${SHOTS}18-missing-tables.png` });
  await c.close();
}

/* -- 2. RLS refusal / signed out ------------------------------------------ */
{
  const c = await ctx(); const page = await c.newPage();
  await installMock(page);
  await page.route('**/demo.supabase.co/rest/v1/**', (r) => r.fulfill({
    status: 401, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }),
  }));
  await seedConnection(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const text = await page.locator('#connection-gate').textContent();
  check('expired session → shows the sign-in form, not a blank screen',
    /Sign in/i.test(text ?? '') && await page.locator('#field-password').isVisible());
  check('sign-in form explains the password is not stored', /never stored/i.test(text ?? ''));
  check('sign-in form offers switching project', await page.locator('#btn-change-project').isVisible());
  await page.screenshot({ path: `${SHOTS}19-signin.png` });
  await c.close();
}

/* -- 3. empty library ----------------------------------------------------- */
{
  const c = await ctx(); const page = await c.newPage();
  await installMock(page, { emptyLibrary: true });
  await seedConnection(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const text = await page.locator('#home-root').textContent();
  check('empty library → helpful empty state, not a blank screen',
    /library is empty/i.test(text ?? '') && /import/i.test(text ?? ''));
  await page.screenshot({ path: `${SHOTS}20-empty-library.png` });

  await page.click('[data-nav-href="/library"]');
  await page.waitForTimeout(1200);
  check('empty Library tab has its own empty state',
    /No songs yet/i.test(await page.locator('#library-root').textContent() ?? ''));
  await c.close();
}

/* -- 4. missing audio file ------------------------------------------------ */
{
  const c = await ctx(); const page = await c.newPage();
  await installMock(page);
  await seedConnection(page);
  await page.route('**/storage/v1/object/sign/music/**', (r) => r.fulfill({
    status: 404, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ message: 'Object not found', statusCode: '404' }),
  }));
  await page.goto(`${BASE}/album?id=al1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('.track-row').first().click();
  await page.waitForTimeout(2000);
  const toast = await page.locator('#app-toast').count();
  check('missing audio file → surfaces an error toast rather than failing silently', toast > 0,
    await page.locator('#app-toast').textContent() ?? '');
  await page.screenshot({ path: `${SHOTS}21-missing-audio.png` });
  await c.close();
}

/* -- 5. network failure --------------------------------------------------- */
{
  const c = await ctx(); const page = await c.newPage();
  await seedConnection(page);
  await page.route('**/demo.supabase.co/**', (r) => r.abort('connectionfailed'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const gateVisible = await page.locator('#connection-gate').isVisible();
  const text = await page.locator('#connection-gate').textContent();
  check('unreachable project → shows an explanatory gate, never a blank page',
    gateVisible && (text ?? '').trim().length > 20, (text ?? '').replace(/\s+/g,' ').slice(0, 70));
  await page.screenshot({ path: `${SHOTS}22-network-failure.png` });
  await c.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
