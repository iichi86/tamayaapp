import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
    { name: 'mobile-320', use: { viewport: { width: 320, height: 740 } } },
  ],
  webServer: {
    command: 'npm run web -- --port 8081',
    url: 'http://127.0.0.1:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      EXPO_OFFLINE: '1',
      EXPO_PUBLIC_APP_MODE: 'demo',
      EXPO_NO_TELEMETRY: '1',
      __UNSAFE_EXPO_HOME_DIRECTORY: resolve(process.cwd(), '.expo-user'),
    },
  },
});
