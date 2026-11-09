import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ID, BUNDLE_ID, PROJECT_ID, REPAIR_FILES, REPAIR_REF,
  patchCameraConfiguration, repairBuildArguments, repairIosPermissions } from '../scripts/repair-ios-permissions.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bodies = new Map([
  ['src/screens/Scanner.native.tsx', Buffer.from('export const fixtureScanner = { mode: "picture", mute: true };\n')],
  ['scripts/release-check.mjs', Buffer.from('/* checked public release-check fixture */\n')],
]);
const files = REPAIR_FILES.map(({ path }) => ({ path, sha256: hash(bodies.get(path)) }));
const quiet = () => {};
const privateNames = ['.env', '.env.store.config.json', '.env.review-account.json', 'server/.env.production', 'server/config/tamaya.json', 'eas.json'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-ios-permission-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['src/screens', 'scripts', 'server/config']) await mkdir(join(root, path), { recursive: true });
  const app = { expo: { owner: 'oneight', version: '1.0.0', ios: { bundleIdentifier: BUNDLE_ID, customSetting: 'keep' },
    extra: { eas: { projectId: PROJECT_ID }, futureSetting: { keep: true } },
    plugins: [['expo-camera', { cameraPermission: '既存の会員QR説明を維持します。', otherCameraSetting: 'keep' }], 'other-plugin'] } };
  await writeFile(join(root, 'app.json'), '\uFEFF' + JSON.stringify(app, null, 2).replace(/\n/g, '\r\n') + '\r\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo', dependencies: { expo: '~58.0.22' } }));
  await writeFile(join(root, 'app.config.ts'), 'export default ({ config }) => config;\n');
  await writeFile(join(root, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'remote' },
    build: { production: { autoIncrement: true, futureBuildSetting: 'keep' } },
    submit: { production: { ios: { ascAppId: APP_ID, bundleIdentifier: BUNDLE_ID,
      metadataPath: '.env.store.config.json', futurePrivateSetting: 'private-profile-value' } } } }));
  await writeFile(join(root, '.env'), Buffer.from([239, 187, 191, 255, 1, 2, 10]));
  await writeFile(join(root, '.env.store.config.json'), '{"private":"contact-and-review-password-must-remain"}\r\n');
  await writeFile(join(root, '.env.review-account.json'), '{"password":"existing-review-password-must-remain"}\r\n');
  await writeFile(join(root, 'server/.env.production'), 'DATABASE_URL=do-not-read-or-print\n');
  await writeFile(join(root, 'server/config/tamaya.json'), '{"existing":"backend-is-not-updated"}');
  await writeFile(join(root, '.gitignore'), '.env*\n!.env.example\n');
  await writeFile(join(root, '.easignore'), '.env*\n');
  for (const file of files) await writeFile(join(root, file.path), `previous ${file.path}\n`);
  const state = { actions: [], downloads: [], logs: [] };
  const options = { root, files,
    download: async ({ url, destination }) => {
      state.downloads.push(url);
      const path = [...bodies.keys()].find(path => url.endsWith(`/${path}`));
      assert.ok(path);
      await writeFile(destination, bodies.get(path));
    },
    execute: async (action, context) => {
      state.actions.push(action);
      assert.equal(context.env.EAS_NO_VCS, '1');
      assert.equal(context.env.EAS_PROJECT_ROOT, root);
      assert.equal(context.env.DISABLE_EAS_ANALYTICS, '1');
      assert.equal(context.env.EXPO_IOS_BUNDLE_IDENTIFIER, BUNDLE_ID);
    }, log: value => state.logs.push(value) };
  return { root, app, state, options };
}

async function snapshot(root) {
  const names = ['app.json', ...files.map(file => file.path), ...privateNames];
  return new Map(await Promise.all(names.map(async name => [name, await readFile(join(root, name))])));
}
async function assertUnchanged(root, before, names = [...before.keys()]) {
  for (const name of names) assert.deepEqual(await readFile(join(root, name)), before.get(name), name);
}

const parseApp = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')).expo;

test('patches only camera permission settings while preserving unknown fields and BOM/CRLF', () => {
  const source = Buffer.from('\uFEFF' + JSON.stringify({ expo: { custom: true, plugins: [['expo-camera', {
    cameraPermission: '既存のQR用カメラ説明', microphonePermission: 'generic', barcodeScannerEnabled: true }], 'keep-plugin'] } }, null, 2).replace(/\n/g, '\r\n') + '\r\n');
  const result = patchCameraConfiguration(source);
  const app = parseApp(result);
  assert.equal(app.custom, true);
  assert.deepEqual(app.plugins, [['expo-camera', { cameraPermission: '既存のQR用カメラ説明', microphonePermission: false,
    barcodeScannerEnabled: true, recordAudioAndroid: false }], 'keep-plugin']);
  assert.ok(result.toString().startsWith('\uFEFF'));
  assert.ok(!/(?<!\r)\n/.test(result.toString()));
  assert.deepEqual(patchCameraConfiguration(result), result);
  const generic = patchCameraConfiguration(Buffer.from('{"expo":{"plugins":["expo-camera"]}}'));
  assert.ok(parseApp(generic).plugins[0][1].cameraPermission.includes('QR'));
});

test('downloads only pinned public fixes and keeps private settings/backend/eas bytes untouched', async t => {
  const { root, app, state, options } = await fixture(t);
  const before = await snapshot(root);
  await repairIosPermissions({ ...options, build: true, submit: true });
  assert.deepEqual(state.actions, ['check', 'nativecheck', 'build']);
  assert.equal(state.downloads.length, 2);
  for (const url of state.downloads) assert.ok(url.includes(`/${REPAIR_REF}/`));
  const updated = parseApp(await readFile(join(root, 'app.json')));
  assert.equal(updated.extra.futureSetting.keep, app.expo.extra.futureSetting.keep);
  assert.equal(updated.ios.customSetting, 'keep');
  assert.deepEqual(updated.plugins[0][1], { cameraPermission: '既存の会員QR説明を維持します。', otherCameraSetting: 'keep',
    microphonePermission: false, recordAudioAndroid: false });
  await assertUnchanged(root, before, privateNames);
  for (const file of files) assert.deepEqual(await readFile(join(root, file.path)), bodies.get(file.path));
  for (const value of ['existing-review-password', 'private-profile-value', 'DATABASE_URL']) assert.ok(!state.logs.join('\n').includes(value));
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.ios-permission-')));
});

test('local-only mode checks generated native settings without starting EAS and safely reruns', async t => {
  const { root, state, options } = await fixture(t);
  await repairIosPermissions({ ...options, localOnly: true });
  assert.deepEqual(state.actions, ['check', 'nativecheck']);
  const before = await snapshot(root);
  await repairIosPermissions({ ...options, localOnly: true });
  await assertUnchanged(root, before);
});

test('tampered, empty or interrupted downloads cannot change local files or call EAS', async t => {
  for (const fault of ['tampered', 'empty', 'interrupted']) {
    await t.test(fault, async t => {
      const { root, state, options } = await fixture(t);
      const before = await snapshot(root);
      options.download = async ({ destination }) => {
        if (fault === 'interrupted') throw new Error('private upstream diagnostic');
        await writeFile(destination, fault === 'empty' ? '' : 'tampered bytes');
      };
      await assert.rejects(repairIosPermissions(options));
      await assertUnchanged(root, before);
      assert.deepEqual(state.actions, []);
    });
  }
});

test('failed release or native permission checks restore previous files and never start EAS', async t => {
  for (const failingAction of ['check', 'nativecheck']) {
    await t.test(failingAction, async t => {
      const { root, state, options } = await fixture(t);
      const before = await snapshot(root);
      options.execute = async action => { state.actions.push(action); if (action === failingAction) throw new Error('private SDK error'); };
      await assert.rejects(repairIosPermissions({ ...options, build: true, submit: true }), /元に戻しました/);
      await assertUnchanged(root, before);
      assert.ok(!state.actions.includes('build'));
      assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.ios-permission-')));
    });
  }
});

test('EAS failure retains the verified local correction without overwriting private state', async t => {
  const { root, options } = await fixture(t);
  const before = await snapshot(root);
  options.execute = async action => { if (action === 'build') throw new Error('private EAS error'); };
  await assert.rejects(repairIosPermissions({ ...options, build: true, submit: true }), /PCの修正は完了しています/);
  assert.equal(parseApp(await readFile(join(root, 'app.json'))).plugins[0][1].microphonePermission, false);
  await assertUnchanged(root, before, privateNames);
});

test('refuses wrong projects, duplicate plugins, source symlinks, empty sources and native ios folders', async t => {
  for (const fault of ['project', 'asc', 'duplicate', 'symlink', 'empty-source', 'native-ios']) {
    await t.test(fault, async t => {
      const { root, state, options } = await fixture(t);
      if (fault === 'project') {
        const app = parseApp(await readFile(join(root, 'app.json')));
        app.extra.eas.projectId = 'wrong';
        await writeFile(join(root, 'app.json'), JSON.stringify({ expo: app }));
      }
      if (fault === 'asc') {
        const eas = JSON.parse(await readFile(join(root, 'eas.json'), 'utf8'));
        eas.submit.production.ios.ascAppId = '999999';
        await writeFile(join(root, 'eas.json'), JSON.stringify(eas));
      }
      if (fault === 'duplicate') {
        const app = parseApp(await readFile(join(root, 'app.json')));
        app.plugins.push('expo-camera');
        await writeFile(join(root, 'app.json'), JSON.stringify({ expo: app }));
      }
      if (fault === 'symlink') {
        const source = join(root, files[0].path);
        await rm(source);
        await writeFile(join(root, 'source-copy.tsx'), 'existing source');
        await symlink(join(root, 'source-copy.tsx'), source);
      }
      if (fault === 'empty-source') await writeFile(join(root, files[0].path), '');
      if (fault === 'native-ios') await mkdir(join(root, 'ios'));
      const before = await snapshot(root);
      await assert.rejects(repairIosPermissions(options));
      await assertUnchanged(root, before);
      assert.deepEqual(state.actions, []);
    });
  }
});

test('refuses a later temp unignore rule before saving data', async t => {
  for (const policy of ['.gitignore', '.easignore']) {
    await t.test(policy, async t => {
      const { root, options, state } = await fixture(t);
      await writeFile(join(root, policy), '.env*\n!.env.ios-permission-*.tmp\n');
      const before = await snapshot(root);
      await assert.rejects(repairIosPermissions(options), /除外する設定/);
      await assertUnchanged(root, before);
      assert.deepEqual(state.actions, []);
    });
  }
});

test('does not overwrite an app setting edited during downloads', async t => {
  const { root, options, state } = await fixture(t);
  const download = options.download;
  let changed = false;
  options.download = async input => {
    await download(input);
    if (!changed) {
      const app = parseApp(await readFile(join(root, 'app.json')));
      app.extra.newOwnerEdit = 'keep-new-edit';
      await writeFile(join(root, 'app.json'), JSON.stringify({ expo: app }));
      changed = true;
    }
  };
  await assert.rejects(repairIosPermissions(options), /処理中に変更/);
  assert.equal(parseApp(await readFile(join(root, 'app.json'))).extra.newOwnerEdit, 'keep-new-edit');
  assert.equal(parseApp(await readFile(join(root, 'app.json'))).plugins[0][1].microphonePermission, undefined);
  assert.deepEqual(state.actions, []);
});

test('validates flags and pins an iOS rebuild with fresh cache and optional upload only', async t => {
  assert.deepEqual(repairBuildArguments(false), ['eas-cli@25.3.0', 'build', '--platform', 'ios', '--profile', 'production', '--non-interactive', '--clear-cache']);
  assert.deepEqual(repairBuildArguments(true), [...repairBuildArguments(false), '--auto-submit-with-profile', 'production']);
  const { options, state } = await fixture(t);
  await assert.rejects(repairIosPermissions({ ...options, submit: true }), /--build/);
  await assert.rejects(repairIosPermissions({ ...options, localOnly: true, build: true }), /同時/);
  assert.deepEqual(state.actions, []);
});
