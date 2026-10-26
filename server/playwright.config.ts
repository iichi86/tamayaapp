import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  testDir: './tests', testMatch: 'browser.spec.ts', workers: 1, fullyParallel: false,
  timeout: 45_000, expect: { timeout: 10_000 }, reporter: 'list',
  outputDir: '../test-results/server-browser',
  use: {
    baseURL: 'http://127.0.0.1:3011', headless: true,
    launchOptions: { executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, args: ['--no-sandbox'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run demo', cwd, url: 'http://127.0.0.1:3011/health', reuseExistingServer: false,
    env: { HOST: '127.0.0.1', PORT: '3011', NODE_ENV: 'test', DEMO_DATABASE_PATH: resolve(cwd, 'data', `browser-${randomUUID()}.sqlite`) },
  },
});
