#!/usr/bin/env node
/**
 * Runs every browser suite against a production build.
 *
 *   npm run build && npm run test:e2e
 *
 * Starts `astro preview` itself, waits for it, runs each suite in turn, then
 * shuts the server down. Screenshots land in tests/e2e/shots/.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 4321);
const BASE = `http://localhost:${PORT}`;

const SUITES = [
  ['onboarding', 'onboarding.mjs'],
  ['player + screens', 'player.mjs'],
  ['error states', 'error-states.mjs'],
  ['gate fields', 'gate-fields.mjs'],
  ['in-app upload', 'upload.mjs'],
];

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], {
      stdio: 'inherit',
      env: { ...process.env, E2E_BASE_URL: BASE },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const server = spawn('npx', ['astro', 'preview', '--port', String(PORT)], {
  cwd: join(here, '..', '..'),
  stdio: 'ignore',
});

let exitCode = 0;
try {
  if (!(await waitForServer(BASE))) {
    console.error(`\n✗ preview server never came up on ${BASE}. Did you run "npm run build"?\n`);
    process.exit(1);
  }

  for (const [label, file] of SUITES) {
    console.log(`\n${'═'.repeat(58)}\n  ${label}\n${'═'.repeat(58)}`);
    const code = await run(file);
    if (code !== 0) exitCode = code;
  }
} finally {
  server.kill();
}

console.log(exitCode === 0 ? '\n✓ all browser suites passed\n' : '\n✗ some browser suites failed\n');
process.exit(exitCode);
