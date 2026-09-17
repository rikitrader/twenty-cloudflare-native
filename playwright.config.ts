import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8788';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results/playwright',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: { mode: 'only-on-failure', fullPage: true },
    video: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true' ? undefined : {
    command: 'node scripts/start-playwright-worker.mjs',
    url: `${baseURL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet-chromium', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
