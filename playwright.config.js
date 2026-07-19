'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Every spec drives a real WebGL scene. Two of them at once on a CI runner
  // with software rendering starve each other: pages time out, contexts get
  // torn down mid-test, and physics assertions read half-simulated state. The
  // failures look like product bugs but move around between runs. Locally,
  // where there is a GPU, two workers are fine and roughly halve the wall time.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: true,
    launchOptions: {
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm start',
    env: {
      ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      HOST: '127.0.0.1',
      PORT: '3000',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: 'http://127.0.0.1:3000/health',
  },
});
