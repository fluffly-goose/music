import { chromium } from 'playwright';
import { installMock, seedConnection, PROJECT, ANON_KEY } from './supabase-mock.mjs';
import { mkdirSync } from 'node:fs';
import { launchOptions } from './launch.mjs';

const BASE = process.env.E2E_BASE_URL ?? (process.env.E2E_BASE_URL ?? 'http://localhost:4321');
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch(launchOptions());
// iPhone 14 Pro viewport + iOS UA, the primary target.
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// ---------------------------------------------------------------- onboarding
await installMock(page);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const gateVisible = await page.locator('#connection-gate').isVisible();
check('onboarding gate shows when no connection is saved', gateVisible);
check('gate asks for project URL', await page.locator('#field-url').isVisible());
check('gate asks for publishable key', await page.locator('#field-key').isVisible());
check('gate has a Remember toggle', await page.locator('#field-remember').isVisible());
await page.screenshot({ path: `${SHOTS}01-onboarding.png` });

// Validation: a service-role key must be refused.
const serviceKey =
  Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url') + '.' +
  Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.sig';
await page.fill('#field-url', PROJECT);
await page.fill('#field-key', serviceKey);
await page.click('#btn-connect');
await page.waitForTimeout(400);
const keyError = await page.locator('[data-error-for="publishableKey"]').textContent();
check('refuses a service-role key', /service-role|secret/i.test(keyError ?? ''), (keyError ?? '').slice(0, 60));
await page.screenshot({ path: `${SHOTS}02-refuses-service-key.png` });

// Connection test button.
await page.fill('#field-key', ANON_KEY);
await page.click('#btn-test');
await page.waitForTimeout(900);
const testText = await page.locator('#test-result').textContent();
check('connection test reports schema + bucket', /tables found/i.test(testText ?? ''), (testText ?? '').replace(/\s+/g, ' ').slice(0, 80));
await page.screenshot({ path: `${SHOTS}03-connection-test.png` });

// ------------------------------------------------------------- connected app
const page2 = await context.newPage();
page2.on('console', (m) => { if (m.type() === 'error') errors.push(`[p2] ${m.text()}`); });
page2.on('pageerror', (e) => errors.push(`[p2] pageerror: ${e.message}`));
await installMock(page2);
await seedConnection(page2, BASE);

await page2.goto(BASE, { waitUntil: 'networkidle' });
await page2.waitForTimeout(1200);

check('remembered connection restores straight into the app',
  !(await page2.locator('#connection-gate').isVisible()));

const homeText = await page2.locator('#home-root').textContent();
check('home greets and shows library counts', /songs/.test(homeText ?? ''), (homeText ?? '').replace(/\s+/g, ' ').slice(0, 70));
check('home shows Recently played', /Recently played/.test(homeText ?? ''));
check('home shows Recently added', /Recently added/.test(homeText ?? ''));

const coversLoaded = await page2.evaluate(() =>
  [...document.querySelectorAll('#home-root img.artwork')].filter((i) => i.naturalWidth > 0).length);
check('album artwork loads via signed URLs', coversLoaded > 0, `${coversLoaded} images`);
await page2.screenshot({ path: `${SHOTS}04-home.png` });

await browser.close();
console.log('\n--- console errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
