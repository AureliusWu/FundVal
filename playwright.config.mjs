import { defineConfig } from '@playwright/test';

const port = Number(process.env.FUNDVAL_E2E_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FundVal E2E port.');
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [['list']],
  outputDir: './site/.playwright-results',
  use: {
    baseURL: origin,
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run serve',
    url: `${origin}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
