import { chromium } from 'playwright';
import { launchOptions } from './launch.mjs';
import { installMock, seedConnection } from './supabase-mock.mjs';
import { mkdirSync } from 'node:fs';

/**
 * The signed-out case.
 *
 * Row Level Security FILTERS rows on SELECT rather than raising, so a project
 * with correct policies answers an anonymous client with `200 []`. Nothing
 * about that looks like an error, which is exactly why it is easy to mistake
 * for "connected to an empty library".
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4321';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// Credentials saved, no session, and RLS hiding every row.
await installMock(page, { emptyLibrary: true });
await seedConnection(page, { withSession: false });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

const gateVisible = await page.locator('#connection-gate').isVisible();
check('signed out with RLS hiding rows prompts for sign-in, not an empty library',
  gateVisible, gateVisible ? '' : 'gate hidden — user is stranded');

if (gateVisible) {
  const text = await page.locator('#connection-gate').textContent();
  check('the prompt is the sign-in form', await page.locator('#field-password').isVisible());
  check('it does not ask for the project details again', !/publishable key/i.test(text ?? ''));
}
await page.screenshot({ path: `${SHOTS}28-signed-out-home.png` });

// Settings must offer a way back in, since that is where the app points people.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const settingsText = await page.locator('#settings-root').textContent();
check('Settings shows it is connected but signed out', /signed out|not signed in/i.test(settingsText ?? ''),
  (settingsText ?? '').replace(/\s+/g, ' ').slice(0, 80));
check('Settings offers a Sign in action', await page.locator('#btn-signin-settings').count() > 0);
await page.screenshot({ path: `${SHOTS}29-signed-out-settings.png`, fullPage: true });

// And it must actually work, not just exist.
if (await page.locator('#btn-signin-settings').count() > 0) {
  await page.click('#btn-signin-settings');
  await page.waitForTimeout(800);
  check('the Sign in action opens a usable sign-in form',
    await page.locator('#field-password').isVisible());
  await page.screenshot({ path: `${SHOTS}30-signin-from-settings.png` });

  await page.fill('#field-email', 'me@example.com');
  await page.fill('#field-password', 'hunter2');
  await page.click('#btn-signin');
  await page.waitForTimeout(1800);
  check('signing in from Settings dismisses the form',
    !(await page.locator('#field-password').isVisible()));
  check('and the app is usable afterwards',
    /me@example\.com/.test(await page.locator('#settings-root').textContent() ?? ''));
}

// The upload screen must not dead-end either.
await page.goto(`${BASE}/upload`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('upload screen is reachable once signed in', await page.locator('#dropzone').isVisible());

// ------------------------------------------- the deliberately-public library
// Someone who relaxed RLS to allow anonymous reads must not be nagged, and
// their choice must survive a reload.
{
  const anon = await context.browser().newContext({ viewport: { width: 393, height: 852 } });
  const p2 = await anon.newPage();
  await installMock(p2);                                 // rows ARE visible
  await seedConnection(p2, { withSession: false });
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1800);
  check('an anonymously-readable library is not blocked by a sign-in prompt',
    !(await p2.locator('#connection-gate').isVisible()));
  check('and its tracks are shown',
    /Recently added|songs/.test(await p2.locator('#home-root').textContent() ?? ''));
  await anon.close();
}

// And the explicit opt-out must be remembered.
{
  const skip = await context.browser().newContext({ viewport: { width: 393, height: 852 } });
  const p3 = await skip.newPage();
  await installMock(p3, { emptyLibrary: true });
  await seedConnection(p3, { withSession: false });
  await p3.goto(BASE, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(1500);
  await p3.click('#btn-skip-auth');
  await p3.waitForTimeout(800);
  check('"Continue without signing in" dismisses the prompt',
    !(await p3.locator('#connection-gate').isVisible()));

  await p3.reload({ waitUntil: 'networkidle' });
  await p3.waitForTimeout(1800);
  check('and is remembered across a reload, rather than asked every visit',
    !(await p3.locator('#connection-gate').isVisible()));
  await skip.close();
}

await browser.close();
const unexpected = [...new Set(errors)];
console.log('\n--- unexpected console errors ---');
console.log(unexpected.length ? unexpected.join('\n') : '(none)');
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || unexpected.length ? 1 : 0);
