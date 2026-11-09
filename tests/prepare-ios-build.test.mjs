import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BUNDLE_ID, PROJECT_ID, RELEASE_FILES, easArguments, prepareIosBuild, updateEnvironment, verifyPublicBackend } from '../scripts/prepare-ios-build.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const app = { expo: { owner: 'oneight', extra: { eas: { projectId: PROJECT_ID } },
  plugins: [['expo-camera', { cameraPermission: '会員QRコードの読取りに使用します。',
    microphonePermission: false, recordAudioAndroid: false }]] } };
const publicEnv = '# fixture\nEXPO_PUBLIC_APP_MODE=production\nEXPO_PUBLIC_API_URL=https://fixture.example.com\nEXPO_PUBLIC_FIREBASE_API_KEY=fixture-key\nEXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=fixture.example.com\nEXPO_PUBLIC_FIREBASE_PROJECT_ID=fixture-project\nEXPO_PUBLIC_FIREBASE_APP_ID=fixture-app\n';
const env = publicEnv + `EAS_PROJECT_ID=${PROJECT_ID}\nEXPO_IOS_BUNDLE_IDENTIFIER=\nRELEASE_BUSINESS_APPROVED=0\nOTHER_PRIVATE_VALUE=do-not-print-or-change\n`;
const store = { id: 'tamaya', address: 'fixture', phone: 'fixture', informationSource: 'fixture',
  reward: { operationsEnabled: true, benefit: { kind: 'item' }, combinationRule: 'fixture' },
  legal: { termsVersion: '2026-11-04-1', privacyVersion: '2026-11-04-1', termsText: '会員規約', privacyText: '方針' } };
const bodies = new Map([
  ['app.json', Buffer.from(JSON.stringify(app))],
  ['app.config.ts', Buffer.from('export default ({ config }) => config;\n')],
  ['.easignore', Buffer.from('.env*\n')],
  ['eas.json', Buffer.from('{"build":{"production":{}}}\n')],
  ['server/config/tamaya.json', Buffer.from(JSON.stringify(store))],
  ['assets/app-icon.png', Buffer.from('fixture-only-image-content')],
]);
const files = RELEASE_FILES.map(({ path }) => ({ path, sha256: hash(bodies.get(path)) }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-ios-prepare-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'server/config', 'assets']) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo', dependencies: { expo: '~58.0.22' } }));
  await writeFile(join(root, '.env'), env);
  for (const [path, bytes] of bodies) await writeFile(join(root, path), path === 'app.json' ? bytes : Buffer.from(`old ${path}`));
  await copyFile(join(projectRoot, 'scripts/release-check.mjs'), join(root, 'scripts/release-check.mjs'));
  return root;
}

async function snapshot(root) {
  const all = {};
  for (const path of [...RELEASE_FILES.map(entry => entry.path), '.env']) all[path] = await readFile(join(root, path));
  return all;
}

const download = async ({ url, destination }) => {
  const path = [...bodies.keys()].find(path => url.endsWith(`/${path}`));
  assert.ok(path, url);
  await writeFile(destination, bodies.get(path));
};
const quiet = () => {};

test('updates checked public inputs, preserves unrelated .env text and can rerun safely', async t => {
  const root = await fixture(t);
  const messages = [];
  const commands = [];
  const execute = async (action, { env: childEnv, root: childRoot }) => {
    commands.push(action);
    assert.equal(childRoot, root);
    assert.equal(childEnv.EAS_NO_VCS, '1');
    assert.equal(childEnv.EAS_PROJECT_ROOT, root);
    assert.equal(childEnv.EXPO_IOS_BUNDLE_IDENTIFIER, BUNDLE_ID);
    assert.equal(childEnv.RELEASE_BUSINESS_APPROVED, '1');
  };
  await prepareIosBuild({ root, download, files, execute, verifyBackend: async () => {}, log: message => messages.push(message) });
  const first = await snapshot(root);
  for (const [path, bytes] of bodies) assert.deepEqual(first[path], bytes);
  assert.match(first['.env'].toString(), /OTHER_PRIVATE_VALUE=do-not-print-or-change\n/);
  assert.ok(first['.env'].toString().startsWith(publicEnv));
  assert.ok(!messages.join('\n').includes('do-not-print-or-change'));
  assert.deepEqual(commands, ['check', 'approval']);
  await prepareIosBuild({ root, download, files, execute, verifyBackend: async () => {}, log: quiet });
  assert.deepEqual(await snapshot(root), first);
});

test('an interrupted or tampered download cannot change any local input', async t => {
  for (const failure of ['interrupt', 'tamper']) {
    const root = await fixture(t);
    const before = await snapshot(root);
    let count = 0;
    await assert.rejects(prepareIosBuild({ root, files, log: quiet, execute: async () => assert.fail('must not execute'),
      download: async entry => {
        count++;
        if (count === 3) {
          if (failure === 'interrupt') throw new Error('fixture network interruption');
          await writeFile(entry.destination, 'unexpected response');
        } else await download(entry);
      } }));
    assert.deepEqual(await snapshot(root), before);
  }
});

test('a failed local check restores original bytes and does not call EAS', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const actions = [];
  await assert.rejects(prepareIosBuild({ root, download, files, log: quiet,
    execute: async action => { actions.push(action); throw new Error('fixture check failure'); } }), /元に戻しました/);
  assert.deepEqual(actions, ['check']);
  assert.deepEqual(await snapshot(root), before);
  const names = await readdir(root);
  assert.ok(!names.some(name => name.startsWith('.env.tamaya-update-')));
});

test('an EAS failure retains the valid local update and never starts a build', async t => {
  const root = await fixture(t);
  const actions = [];
  await assert.rejects(prepareIosBuild({ root, download, files, build: true, log: quiet,
    verifyBackend: async () => {},
    execute: async action => { actions.push(action); if (action === 'approval') throw new Error('fixture EAS unavailable'); } }), /PCの更新は完了/);
  assert.deepEqual(actions, ['check', 'approval']);
  assert.match(await readFile(join(root, '.env'), 'utf8'), /RELEASE_BUSINESS_APPROVED=1/);
  assert.deepEqual(await readFile(join(root, 'assets/app-icon.png')), bodies.get('assets/app-icon.png'));
});

test('--build proceeds only after the checked local inputs, backend and EAS approval', async t => {
  const root = await fixture(t);
  const actions = [];
  await prepareIosBuild({ root, download, files, build: true, log: quiet,
    verifyBackend: async ({ expectedStore }) => { assert.equal(expectedStore.id, 'tamaya'); actions.push('backend'); },
    execute: async action => { actions.push(action); } });
  assert.deepEqual(actions, ['check', 'backend', 'approval', 'build']);
});

test('TestFlight upload is enabled only with an explicit submit request after preparation succeeds', async t => {
  const root = await fixture(t);
  const actions = [];
  await prepareIosBuild({ root, download, files, build: true, submit: true, log: quiet,
    verifyBackend: async () => { actions.push('backend'); },
    execute: async (action, context) => {
      actions.push(action);
      if (action === 'build') {
        assert.equal(context.submit, true);
        assert.deepEqual(easArguments(action, context.submit), ['eas-cli@25.3.0', 'build', '--platform', 'ios', '--profile', 'production', '--auto-submit-with-profile', 'production']);
      }
    } });
  assert.deepEqual(actions, ['check', 'backend', 'approval', 'build']);
  assert.ok(!easArguments('build').includes('--auto-submit-with-profile'));
  assert.ok(!easArguments('approval', true).includes('--auto-submit-with-profile'));
  assert.throws(() => easArguments('publish'), /正しくありません/);
});

test('submit without a build is rejected before files or external actions are accessed', async () => {
  for (const options of [{ submit: true }, { submit: true, localOnly: true }]) {
    await assert.rejects(prepareIosBuild({ root: '/not-a-project', ...options,
      download: async () => assert.fail('must not download'),
      execute: async () => assert.fail('must not execute') }), /--submit/);
  }
});

test('a backend check failure retains the prepared PC and prevents all EAS mutations', async t => {
  const root = await fixture(t);
  const actions = [];
  await assert.rejects(prepareIosBuild({ root, download, files, build: true, log: quiet,
    verifyBackend: async () => { throw new Error('fixture backend not deployed'); },
    execute: async action => { actions.push(action); } }), /公開サーバーへの正式設定/);
  assert.deepEqual(actions, ['check']);
  assert.match(await readFile(join(root, '.env'), 'utf8'), /RELEASE_BUSINESS_APPROVED=1/);
});

test('public backend verification checks Firebase health and approved bodies, excluding effective URLs', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'tamaya-public-backend-test-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  let remote = { ...store, legal: { ...store.legal, privacyUrl: 'https://tamayaapp.onrender.com/privacy' } };
  let health = { status: 'ok', authMode: 'firebase' };
  const urls = [];
  const backendDownload = async ({ url, destination }) => {
    urls.push(url);
    await writeFile(destination, JSON.stringify(url.endsWith('/health') ? health : remote));
  };
  await verifyPublicBackend({ stage, expectedStore: store, download: backendDownload });
  assert.deepEqual(urls, ['https://tamayaapp.onrender.com/health', 'https://tamayaapp.onrender.com/v1/stores/tamaya']);
  remote = { ...remote, legal: { ...remote.legal, termsText: 'old body' } };
  await assert.rejects(verifyPublicBackend({ stage, expectedStore: store, download: backendDownload }), /正式文面/);
  remote = { ...store };
  health = { status: 'ok', authMode: 'emulator' };
  await assert.rejects(verifyPublicBackend({ stage, expectedStore: store, download: backendDownload }), /起動状態/);
});

test('rejects another project or a target symlink before downloading', async t => {
  const root = await fixture(t);
  const bad = JSON.parse(JSON.stringify(app)); bad.expo.extra.eas.projectId = 'another-project';
  await writeFile(join(root, 'app.json'), JSON.stringify(bad));
  await assert.rejects(prepareIosBuild({ root, files, log: quiet, download: async () => assert.fail('must not download') }), /登録済みEAS/);
  await writeFile(join(root, 'app.json'), JSON.stringify(app));
  const outside = await mkdtemp(join(tmpdir(), 'tamaya-ios-outside-test-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(join(root, 'assets'), { recursive: true });
  await symlink(outside, join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareIosBuild({ root, files, log: quiet, download: async () => assert.fail('must not download') }), /リンク/);
  assert.deepEqual(await readdir(outside), []);
});

test('local-only runs the actual existing release checker without EAS', async t => {
  const root = await fixture(t);
  await prepareIosBuild({ root, download, files, localOnly: true, log: quiet });
  assert.match(await readFile(join(root, '.env'), 'utf8'), /RELEASE_BUSINESS_APPROVED=1/);
});

test('an unsupported .env encoding is rejected before any download or file change', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), Buffer.from([0xff, 0xfe, 0x45, 0x00]));
  const before = await snapshot(root);
  await assert.rejects(prepareIosBuild({ root, files, log: quiet,
    download: async () => assert.fail('must not download') }), /UTF-8/);
  assert.deepEqual(await snapshot(root), before);
});

test('dotenv editing preserves BOM, CRLF and target-looking text inside a multiline value', () => {
  const original = '\uFEFF# private fixture\r\nPRIVATE_MULTILINE="first\r\nRELEASE_BUSINESS_APPROVED=inside-secret\r\nlast"\r\nexport RELEASE_BUSINESS_APPROVED = "0" # old\r\nEXPO_IOS_BUNDLE_IDENTIFIER = ""\r\nOTHER_PRIVATE_VALUE=leave-exactly\r\n';
  const result = updateEnvironment(original);
  assert.ok(result.startsWith('\uFEFF# private fixture\r\n'));
  assert.ok(result.includes('PRIVATE_MULTILINE="first\r\nRELEASE_BUSINESS_APPROVED=inside-secret\r\nlast"\r\n'));
  assert.ok(result.endsWith('OTHER_PRIVATE_VALUE=leave-exactly\r\n'));
  assert.ok(result.includes('RELEASE_BUSINESS_APPROVED=1\r\n'));
  assert.ok(result.includes(`EXPO_IOS_BUNDLE_IDENTIFIER=${BUNDLE_ID}\r\n`));
  assert.equal(updateEnvironment(result), result);
  assert.throws(() => updateEnvironment('RELEASE_BUSINESS_APPROVED=0\nexport RELEASE_BUSINESS_APPROVED = 1\n'), /重複/);
  assert.throws(() => updateEnvironment('PRIVATE_MULTILINE="unfinished\n'), /引用符/);
  assert.throws(() => updateEnvironment('EAS_PROJECT_ID=another-project\n'), /一致しません/);
  for (const quote of ['"', "'", '`']) {
    assert.throws(() => updateEnvironment(`PRIVATE=${quote}value\\${quote}\nEAS_PROJECT_ID=another-project\nOTHER=${quote}close${quote}\n`), /一致しません/);
  }
});
