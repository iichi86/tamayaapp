import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './tests', testMatch: 'production.browser.spec.ts',
  timeout: 150_000, expect: { timeout: 15_000 }, workers: 1, fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-production' }]],
  outputDir: 'test-results/production',
  use: {
    baseURL: 'http://localhost:8083', headless: true, viewport: { width: 390, height: 900 },
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/local-services.mjs', url: 'http://localhost:8083',
    timeout: 240_000, reuseExistingServer: process.env.PRODUCTION_REUSE_LOCAL === '1',
    stdout: 'pipe', stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: {
      CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1',
      __UNSAFE_EXPO_HOME_DIRECTORY: resolve(process.cwd(), '.expo-user'),
    },
  },
});
