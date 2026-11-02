import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localProjectId = '11111111-1111-4111-8111-111111111111';
const buildProjectId = '22222222-2222-4222-8222-222222222222';

async function fixture(t, extra = undefined) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-app-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['app.config.ts', 'package.json']) {
    await copyFile(join(projectRoot, file), join(root, file));
  }
  const app = JSON.parse(await readFile(join(projectRoot, 'app.json'), 'utf8'));
  if (extra) app.expo.extra = extra;
  await writeFile(join(root, 'app.json'), JSON.stringify(app));
  for (const directory of ['node_modules', 'assets']) {
    await symlink(join(projectRoot, directory), join(root, directory), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
}

function run(root, source, environment = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EAS_') || key.startsWith('EXPO_PUBLIC_')
      || key === 'EXPO_IOS_BUNDLE_IDENTIFIER' || key === 'RELEASE_BUSINESS_APPROVED') delete env[key];
  }
  Object.assign(env, {
    EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', CI: '1', ...environment,
  });
  // A child process keeps native dotenv loading and config-module caches isolated
  // from the test runner and from the real project's environment file.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
  });
  assert.equal(child.error, undefined, 'Configuration check child process must finish');
  assert.equal(child.status, 0, child.stderr || child.stdout || 'Configuration check failed');
}

test('EAS-disabled dotenv loading still resolves local IDs and preserves build-environment overrides', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), [
    `EAS_PROJECT_ID=${localProjectId}`,
    'EXPO_IOS_BUNDLE_IDENTIFIER=jp.tamaya.fixture.local',
    'EXPO_PUBLIC_APP_MODE=production',
    '',
  ].join('\n'));
  const check = `
    import assert from 'node:assert/strict';
    import config from '@expo/config';
    const { exp } = config.getConfig(process.cwd());
    assert.equal(exp.extra.eas.projectId, process.env.EXPECTED_PROJECT_ID);
    assert.equal(exp.ios.bundleIdentifier, process.env.EXPECTED_BUNDLE_ID);
  `;
  run(root, check, {
    EXPECTED_PROJECT_ID: localProjectId, EXPECTED_BUNDLE_ID: 'jp.tamaya.fixture.local',
  });
  run(root, check, {
    EAS_PROJECT_ID: buildProjectId, EXPO_IOS_BUNDLE_IDENTIFIER: 'jp.tamaya.fixture.build',
    EXPECTED_PROJECT_ID: buildProjectId, EXPECTED_BUNDLE_ID: 'jp.tamaya.fixture.build',
  });
});

test('production config works without a local env file and keeps the missing-Bundle-ID guard', async (t) => {
  const root = await fixture(t);
  run(root, `
    import assert from 'node:assert/strict';
    import config from '@expo/config';
    const { exp } = config.getConfig(process.cwd());
    assert.equal(exp.extra.eas.projectId, '${buildProjectId}');
    assert.equal(exp.ios.bundleIdentifier, 'jp.tamaya.fixture.build');
    delete process.env.EXPO_IOS_BUNDLE_IDENTIFIER;
    assert.throws(() => config.getConfig(process.cwd()), /本番の接続設定とiOS Bundle Identifierが未設定/);
  `, {
    EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_APP_MODE: 'production',
    EAS_PROJECT_ID: buildProjectId, EXPO_IOS_BUNDLE_IDENTIFIER: 'jp.tamaya.fixture.build',
  });
});

test('same-process EAS project and owner writes are visible without dropping unrelated extra fields', async (t) => {
  const root = await fixture(t, { customMarker: 'preserved', eas: { customEasMarker: 'also-preserved' } });
  run(root, `
    import assert from 'node:assert/strict';
    import config from '@expo/config';
    const first = await config.modifyConfigAsync(process.cwd(), { extra: { eas: { projectId: '${localProjectId}' } } });
    assert.equal(first.type, 'success', 'EAS must be able to save and read the project ID');
    const second = await config.modifyConfigAsync(process.cwd(), { owner: 'fixture-owner' });
    assert.equal(second.type, 'success', 'EAS must be able to save and read the owner in the same process');
    const { exp } = config.getConfig(process.cwd());
    assert.equal(exp.owner, 'fixture-owner');
    assert.equal(exp.extra.eas.projectId, '${localProjectId}');
    assert.equal(exp.extra.customMarker, 'preserved');
    assert.equal(exp.extra.eas.customEasMarker, 'also-preserved');
    process.env.EAS_PROJECT_ID = '${buildProjectId}';
    const overridden = config.getConfig(process.cwd()).exp;
    assert.equal(overridden.extra.eas.projectId, '${buildProjectId}');
    assert.equal(overridden.extra.customMarker, 'preserved');
    assert.equal(overridden.extra.eas.customEasMarker, 'also-preserved');
    assert.equal(overridden.owner, 'fixture-owner');
  `);
});
