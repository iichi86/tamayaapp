import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cameraPurpose = '会員証のQRコードを読み取るためにカメラを使用します。';

async function fixture(t, { staleMicrophone = false, omitMicrophoneOption = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-camera-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['app.config.ts', 'package.json']) {
    await copyFile(join(projectRoot, file), join(root, file));
  }
  const app = JSON.parse(await readFile(join(projectRoot, 'app.json'), 'utf8'));
  const camera = app.expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-camera');
  assert.ok(camera, 'The actual camera plugin must be present in the fixture');
  if (omitMicrophoneOption) delete camera[1].microphonePermission;
  if (staleMicrophone) {
    app.expo.ios.infoPlist = { ...app.expo.ios.infoPlist,
      NSMicrophoneUsageDescription: 'Allow app to access your microphone' };
  }
  await writeFile(join(root, 'app.json'), JSON.stringify(app));
  for (const directory of ['node_modules', 'assets']) {
    await symlink(join(projectRoot, directory), join(root, directory),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
}

function nativeInfoPlist(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EAS_') || key.startsWith('EXPO_PUBLIC_')
      || key === 'EXPO_IOS_BUNDLE_IDENTIFIER' || key === 'RELEASE_BUSINESS_APPROVED') delete env[key];
  }
  Object.assign(env, {
    EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_APP_MODE: 'production',
    EXPO_IOS_BUNDLE_IDENTIFIER: 'jp.oneeight.tamaya.members',
    EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1',
    DISABLE_EAS_ANALYTICS: '1', CI: '1',
  });
  // Run the complete installed SDK prebuild plugin chain, including the real
  // dynamic config, without writing native files or using the project's .env.
  const source = `
    import { existsSync } from 'node:fs';
    import prebuild from '@expo/prebuild-config';
    import plugins from '@expo/config-plugins';
    const { exp } = await prebuild.getPrebuildConfigAsync(process.cwd(), { platforms: ['ios'] });
    const compiled = await plugins.compileModsAsync(exp, {
      projectRoot: process.cwd(), platforms: ['ios'], introspect: true,
    });
    const info = compiled._internal.modResults.ios.infoPlist;
    console.log(JSON.stringify({ info,
      barcodeSupportDisabled: compiled._internal.modResults.ios.podfileProperties['expo.camera.barcode-scanner-enabled'] === 'false',
      nativeDirectoryCreated: existsSync('ios'),
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
  });
  assert.equal(child.error, undefined, 'The native permission check must finish');
  assert.equal(child.status, 0, child.stderr || child.stdout || 'Native permission compilation failed');
  return JSON.parse(child.stdout.trim());
}

function assertQrCameraOnly(result) {
  assert.equal(result.info.NSCameraUsageDescription, cameraPurpose);
  assert.equal(Object.hasOwn(result.info, 'NSMicrophoneUsageDescription'), false);
  assert.equal(result.info.ITSAppUsesNonExemptEncryption, false);
  assert.equal(result.barcodeSupportDisabled, false, 'QR support must remain compiled in');
  assert.equal(result.nativeDirectoryCreated, false, 'Introspection must not write a native project');
}

test('production prebuild preserves the QR camera purpose and omits microphone usage', async t => {
  assertQrCameraOnly(nativeInfoPlist(await fixture(t)));
});

test('production prebuild removes a microphone purpose left in the native plist input', async t => {
  assertQrCameraOnly(nativeInfoPlist(await fixture(t, { staleMicrophone: true })));
});

test('omitting the microphone option reproduces the SDK placeholder rejected by Apple', async t => {
  const result = nativeInfoPlist(await fixture(t, { omitMicrophoneOption: true }));
  assert.equal(result.info.NSCameraUsageDescription, cameraPurpose);
  assert.equal(result.info.NSMicrophoneUsageDescription, 'Allow $(PRODUCT_NAME) to access your microphone');
});
