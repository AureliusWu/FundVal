import { defineConfig } from '@playwright/test';

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
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run serve',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
