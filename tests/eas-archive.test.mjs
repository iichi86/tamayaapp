import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function easCopier() {
  const candidates = [];
  if (process.env.EAS_CLI_PACKAGE_ROOT) candidates.push(process.env.EAS_CLI_PACKAGE_ROOT);
  try { candidates.push(dirname(require.resolve('eas-cli/package.json'))); } catch { /* Optional integration dependency. */ }
  const cache = join(projectRoot, '.npm-cache', '_npx');
  try {
    for (const entry of await readdir(cache, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(cache, entry.name, 'node_modules', 'eas-cli'));
    }
  } catch { /* A clean checkout may not have the CLI cache yet. */ }
  for (const candidate of candidates) {
    try {
      if (JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')).version === '25.3.0') {
        return require(join(candidate, 'build', 'vcs', 'local.js')).makeShallowCopyAsync;
      }
    } catch { /* Continue to another installed CLI. */ }
  }
  return null;
}

const copyArchive = await easCopier();
const prerequisite = copyArchive ? false : 'Install EAS CLI 25.3.0 locally, or set EAS_CLI_PACKAGE_ROOT, for this archive integration check.';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-eas-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const output = join(root, 'archive');
  await mkdir(source);
  await copyFile(join(projectRoot, '.easignore'), join(source, '.easignore'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), body);
  }
  await copyArchive(source, output);
  return output;
}

async function archiveFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await archiveFiles(root, path));
    else result.push(path);
  }
  return result;
}

test('EAS archive retains application inputs and the store configuration required by the build guard', { skip: prerequisite }, async (t) => {
  const files = {
    'App.tsx': 'export default function App() {}',
    'index.ts': 'import App from "./App";',
    'app.json': '{"expo":{"name":"Fixture","slug":"fixture"}}',
    'app.config.ts': 'export default ({ config }) => config;',
    'package.json': '{"private":true}',
    'package-lock.json': '{"lockfileVersion":3}',
    'eas.json': '{"build":{"production":{}}}',
    'tsconfig.json': '{}',
    '.npmrc': 'cache=.npm-cache',
    'assets/app-icon.png': 'fixture image bytes',
    'src/production/runtime.ts': 'export {};',
    'shared/contracts.ts': 'export {};',
    'scripts/release-check.mjs': 'console.log("fixture guard");',
    'server/config/tamaya.json': '{"id":"fixture"}',
  };
  const output = await fixture(t, files);
  const copied = await archiveFiles(output);
  for (const path of Object.keys(files)) assert.ok(copied.includes(path), `${path} must reach the native build`);
});

test('EAS archive excludes backend data, credentials, dumps, local settings and development-only files', { skip: prerequisite }, async (t) => {
  const files = {
    '.env': 'FAKE_SECRET=fixture-only',
    '.env.production': 'FAKE_SECRET=fixture-only',
    '.env.example': 'PUBLIC_FIXTURE=example',
    'src/nested/.env.local': 'FAKE_SECRET=fixture-only',
    'firebase-admin.json': 'fixture-only secret',
    'nested/fixture-service-account.json': 'fixture-only secret',
    'nested/credentials.json': 'fixture-only secret',
    'nested/AuthKey_fixture.p8': 'fixture-only secret',
    'nested/distribution.p12': 'fixture-only secret',
    'nested/profile.mobileprovision': 'fixture-only secret',
    'nested/private.key': 'fixture-only secret',
    'nested/private.pem': 'fixture-only secret',
    'nested/customer.dump': 'fixture-only data',
    'nested/customer.backup': 'fixture-only data',
    'nested/customer.sql': 'fixture-only data',
    'nested/customer.bak': 'fixture-only data',
    'nested/customer.sqlite-wal': 'fixture-only data',
    'server/src/production/index.ts': 'fixture-only backend',
    'server/secrets/arbitrary-name.json': 'fixture-only secret',
    'server/config/private.json': 'fixture-only secret',
    'server/.env.production': 'FAKE_SECRET=fixture-only',
    'server/data/custom-name.bin': 'fixture-only data',
    'server/node_modules/fixture/index.js': 'fixture-only dependency',
    'tools/fixture.js': 'fixture-only tool',
    'docs/screenshots/fixture.png': 'fixture-only screenshot',
    'tests/fixture.test.ts': 'fixture-only test',
    'deployment/eas-production.env': 'PUBLIC_FIXTURE=example',
    'scripts/diagnose-install.mjs': 'fixture-only tool',
    'local-data/fixture.json': 'fixture-only data',
    '.firebase/fixture.json': 'fixture-only data',
    '.npm-cache/fixture.bin': 'fixture-only cache',
    '.expo/fixture.json': 'fixture-only cache',
    '.expo-user/fixture.json': 'fixture-only cache',
    'dist/fixture.js': 'fixture-only output',
    'dist-ios/fixture.hbc': 'fixture-only output',
    'test-results/fixture.json': 'fixture-only result',
    'playwright-report/fixture.html': 'fixture-only report',
    'fixture.log': 'fixture-only log',
    'node_modules/fixture/index.js': 'fixture-only dependency',
    '.git/config': 'fixture-only git config',
  };
  const output = await fixture(t, files);
  const copied = await archiveFiles(output);
  assert.deepEqual(copied, ['.easignore']);
});

test('the real release pre-install guard can execute using only the files retained in the EAS archive', { skip: prerequisite }, async (t) => {
  const store = {
    reward: { operationsEnabled: true, benefit: { kind: 'item', label: 'fixture benefit' }, combinationRule: 'fixture' },
    address: 'fixture address', phone: 'fixture phone', informationSource: 'fixture source',
    legal: { termsVersion: 'fixture-1', privacyVersion: 'fixture-1', termsText: 'fixture terms', privacyText: 'fixture privacy' },
  };
  const output = await fixture(t, {
    'app.json': await readFile(join(projectRoot, 'app.json'), 'utf8'),
    'scripts/release-check.mjs': await readFile(join(projectRoot, 'scripts', 'release-check.mjs'), 'utf8'),
    'server/config/tamaya.json': JSON.stringify(store),
  });
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL;
  Object.assign(env, {
    EXPO_PUBLIC_APP_MODE: 'production', EXPO_PUBLIC_API_URL: 'https://fixture.invalid',
    EXPO_PUBLIC_FIREBASE_API_KEY: 'fixture-public-key', EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'fixture.firebaseapp.com',
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'fixture-project', EXPO_PUBLIC_FIREBASE_APP_ID: 'fixture-app',
    EXPO_IOS_BUNDLE_IDENTIFIER: 'jp.fixture.members', RELEASE_BUSINESS_APPROVED: '1', EAS_BUILD_PROFILE: 'production',
  });
  const child = spawnSync(process.execPath, ['scripts/release-check.mjs', '--build'], {
    cwd: output, env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /設定チェック成功/);
  const previous = JSON.parse(await readFile(join(output, 'app.json'), 'utf8'));
  delete previous.expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-camera')[1].microphonePermission;
  await writeFile(join(output, 'app.json'), JSON.stringify(previous));
  const rejected = spawnSync(process.execPath, ['scripts/release-check.mjs', '--build'], {
    cwd: output, env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /マイク権限/);
});
