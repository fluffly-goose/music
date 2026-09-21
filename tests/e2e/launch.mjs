/**
 * Browser launch options.
 *
 * Normally Playwright finds its own Chromium (`npx playwright install chromium`).
 * PLAYWRIGHT_EXECUTABLE_PATH lets a sandbox or CI image point at a preinstalled
 * binary instead.
 */
export function launchOptions(extra = {}) {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  return { ...(executablePath ? { executablePath } : {}), ...extra };
}
