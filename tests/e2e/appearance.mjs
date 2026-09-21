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

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await installMock(page);
await seedConnection(page);

const theme = () => page.evaluate(() => document.documentElement.dataset.theme);

/* ------------------------------------------------------------------- theme */
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.click('[data-theme="midnight"]');
await page.waitForTimeout(700);

check('choosing a theme applies it', (await theme()) === 'midnight');
check('and stores it',
  (await page.evaluate(() => JSON.parse(localStorage.getItem('resonance:preferences') || '{}').theme)) === 'midnight');

// The regression: ClientRouter copies the incoming page's <html> attributes
// over the live ones, and every page ships data-theme="dark" in its markup.
for (const [href, label] of [['/', 'Home'], ['/library', 'Library'], ['/search', 'Search']]) {
  await page.click(`[data-nav-href="${href}"]`);
  await page.waitForTimeout(800);
  check(`the theme survives navigating to ${label}`, (await theme()) === 'midnight', await theme());
}

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('and survives a full reload', (await theme()) === 'midnight');
check('the page actually renders in the midnight palette',
  (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(5, 6, 13)');
await page.screenshot({ path: `${SHOTS}37-midnight-home.png` });

// Put it back for the remaining checks.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('[data-theme="dark"]');
await page.waitForTimeout(600);
check('switching back works too', (await theme()) === 'dark');

/* -------------------------------------------------------------------- logo */
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const homeText = await page.locator('#home-root').textContent();
check('Home leads with the Resonance wordmark', /Resonance/.test(homeText ?? ''));
check('the time-of-day greeting is gone',
  !/Good (morning|afternoon|evening|night)/.test(homeText ?? ''), (homeText ?? '').slice(0, 40));
check('the wordmark is paired with the mark',
  await page.locator('#home-root .logo-word').count() === 1 &&
  await page.locator('#home-root header svg').count() >= 1);
check('library counts still read as a subtitle',
  await page.locator('#home-root .page-subtitle').count() === 1);
await page.screenshot({ path: `${SHOTS}38-home-logo.png` });

/* ----------------------------------------------------------------- headers */
// The scroll region carries the safe-area inset; without it a title sits under
// the status bar and notch on a real iPhone.
// The computed value is 0px in a headless browser with no notch, so assert the
// rule itself rather than its current resolution.
const usesSafeArea = await page.evaluate(() => {
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // cross-origin
    for (const rule of rules) {
      if (rule.selectorText === '.app-scroll' &&
          /env\(\s*safe-area-inset-top/.test(rule.style.getPropertyValue('padding-top'))) {
        return true;
      }
    }
  }
  return false;
});
check('the scroll region reserves the safe-area inset, so titles clear the notch',
  usesSafeArea);

for (const [url, id] of [['/library', 'library-root'], ['/search', 'search-root'], ['/settings', 'settings-root']]) {
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  const box = await page.locator(`#${id} header`).first().boundingBox();
  const title = await page.locator(`#${id} .page-title`).first().boundingBox();
  check(`${url} header uses the shared treatment`, Boolean(box) && Boolean(title));
  // Left-aligned and clear of the top edge - the complaint was titles sitting
  // jammed into a corner.
  check(`${url} title is left-aligned with the page gutter`,
    Math.round(title?.x ?? -1) === 16, String(Math.round(title?.x ?? -1)));
  check(`${url} title has breathing room above it`,
    (title?.y ?? 0) >= 20, String(Math.round(title?.y ?? 0)));
}

/* ------------------------------------------------- search field vs its icon */
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const geometry = await page.evaluate(() => {
  const input = document.getElementById('search-input');
  const icon = input.parentElement.querySelector('span');
  return {
    padding: parseFloat(getComputedStyle(input).paddingLeft),
    iconRight: icon.getBoundingClientRect().right - input.getBoundingClientRect().left,
  };
});
check('the search icon does not sit on top of the placeholder',
  geometry.padding > geometry.iconRight,
  `padding ${geometry.padding}px vs icon ending at ${Math.round(geometry.iconRight)}px`);
await page.screenshot({ path: `${SHOTS}39-search-header.png` });

await browser.close();
const unexpected = [...new Set(errors)];
console.log('\n--- unexpected console errors ---');
console.log(unexpected.length ? unexpected.join('\n') : '(none)');
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || unexpected.length ? 1 : 0);
