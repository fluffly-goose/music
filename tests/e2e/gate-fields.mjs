import { chromium } from 'playwright';
import { launchOptions } from './launch.mjs';
import { installMock, seedConnection, PROJECT } from './supabase-mock.mjs';

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
await installMock(page);
await page.route('**/demo.supabase.co/rest/v1/**', (r) => r.fulfill({
  status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ code: '42P01', message: 'relation "public.tracks" does not exist' }),
}));
await seedConnection(page);
await page.goto((process.env.E2E_BASE_URL ?? 'http://localhost:4321'), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const url = await page.inputValue('#field-url');
const key = await page.inputValue('#field-key');
const bucket = await page.inputValue('#field-bucket');
console.log(`url=${url}  keyLen=${key.length}  bucket=${bucket}`);
console.log(url === PROJECT && key.length > 10 && bucket === 'music'
  ? 'PASS  restored config repopulates the form after a failure'
  : 'FAIL  form not repopulated');

// And typing must still survive a failed submit.
await page.fill('#field-url', 'https://typed-by-user.supabase.co');
await page.click('#btn-connect');
await page.waitForTimeout(1500);
const after = await page.inputValue('#field-url');
console.log(after === 'https://typed-by-user.supabase.co'
  ? 'PASS  user typing survives a failed connect'
  : `FAIL  typing lost (got "${after}")`);
await page.screenshot({ path: new URL('./shots/23-gate-repopulated.png', import.meta.url).pathname });
await browser.close();
