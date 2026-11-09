import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ID = 'b84c88d0-b923-4a2a-b144-9fe5f0528f8d';
export const BUNDLE_ID = 'jp.oneeight.tamaya.members';
export const APP_ID = '6830628549';
export const REPAIR_REF = 'b8fe0e5dbf79c6b8cce26aab06c2236e078c407b';
export const REPAIR_FILES = Object.freeze([
  Object.freeze({ path: 'src/screens/Scanner.native.tsx', sha256: 'd0c595df4ac252228738e06ecb28b404182cdf0800d016a41a19d5925227b790' }),
  Object.freeze({ path: 'scripts/release-check.mjs', sha256: 'a99e928f8605833b575f96452c93e5e07442b9f052707c9420cf52f2385cab22' }),
]);
const CAMERA_PERMISSION = '会員証のQRコードを読み取るためにカメラを使用します。';
const TEMP_PROBE = '.env.ios-permission-00000000-0000-4000-8000-000000000000.tmp';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => a.equals(b);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export class IosPermissionRepairError extends Error {}
const fail = message => new IosPermissionRepairError(message);

async function safePath(root, relative) {
  let path = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path).catch(() => { throw fail('今回のアプリの必要なファイルを確認できません。'); });
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw fail('必要なファイルがリンクまたは通常でない形式のため変更しません。');
    }
  }
  return path;
}

function json(bytes) {
  const text = bytes.toString('utf8');
  try {
    if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error();
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(value)) throw new Error();
    return value;
  } catch { throw fail('アプリの設定JSONを読み取れないため、変更せず終了します。'); }
}

function ignored(contents, filename) {
  let result = false;
  for (let pattern of contents.split(/\r?\n/).map(line => line.trim())) {
    if (!pattern || pattern.startsWith('#')) continue;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    pattern = pattern.replace(/^\//, '').replace(/^\*\*\//, '');
    if (negate && (/[\[\]\\]/.test(pattern) || pattern.includes('**'))) return false;
    if (pattern.includes('/') || pattern.includes('\\')) continue;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (new RegExp(`^${escaped}$`).test(filename)) result = !negate;
  }
  return result;
}

async function checkIgnores(root, name = TEMP_PROBE) {
  for (const path of ['.gitignore', '.easignore']) {
    const contents = await readFile(await safePath(root, path), 'utf8');
    if (![TEMP_PROBE, name].every(file => ignored(contents, file))) {
      throw fail('作業用ファイルをGitとEASから除外する設定を確認できないため変更しません。');
    }
  }
}

async function validateProject(root) {
  for (const path of ['package.json', 'app.json', 'eas.json', '.env', 'app.config.ts', ...REPAIR_FILES.map(file => file.path)]) await safePath(root, path);
  const pkg = json(await readFile(join(root, 'package.json')));
  const appBytes = await readFile(join(root, 'app.json'));
  const app = json(appBytes).expo;
  const eas = json(await readFile(join(root, 'eas.json')));
  const ios = eas.submit?.production?.ios;
  if (pkg.name !== 'tamaya-members-demo' || !/^[~^]?58\./.test(pkg.dependencies?.expo ?? '')
    || app?.owner !== 'oneight' || app?.extra?.eas?.projectId !== PROJECT_ID
    || app?.ios?.bundleIdentifier !== BUNDLE_ID || app?.version !== '1.0.0'
    || !object(eas.build?.production) || eas.build.production.autoIncrement !== true
    || eas.cli?.appVersionSource !== 'remote' || !object(ios)
    || (ios.ascAppId && ios.ascAppId !== APP_ID)
    || (ios.bundleIdentifier && ios.bundleIdentifier !== BUNDLE_ID)
    || (process.env.EAS_PROJECT_ID && process.env.EAS_PROJECT_ID !== PROJECT_ID)
    || (process.env.EXPO_IOS_BUNDLE_IDENTIFIER && process.env.EXPO_IOS_BUNDLE_IDENTIFIER !== BUNDLE_ID)) {
    throw fail('玉屋のSDK 58・1.0.0・登録済みの公開先を確認できないため変更しません。');
  }
  try { await lstat(join(root, 'ios')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw fail('iOSフォルダーの状態を確認できません。');
    await checkIgnores(root);
    return { appBytes };
  }
  throw fail('既存のiosフォルダーがあります。古いネイティブ設定を残さないため、自動更新せず終了します。フォルダーを削除せず、この表示を伝えてください。');
}

export function patchCameraConfiguration(bytes) {
  const next = json(bytes);
  const plugins = next.expo?.plugins;
  if (!Array.isArray(plugins)) throw fail('カメラの設定を確認できません。');
  const indexes = plugins.map((plugin, index) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-camera' ? index : -1).filter(index => index >= 0);
  if (indexes.length !== 1) throw fail('カメラの設定が重複または未設定のため、変更せず終了します。');
  const index = indexes[0];
  const previous = Array.isArray(plugins[index]) ? plugins[index][1] : undefined;
  if (previous !== undefined && !object(previous)) throw fail('カメラの設定形式を確認できません。');
  plugins[index] = ['expo-camera', { ...previous,
    cameraPermission: typeof previous?.cameraPermission === 'string' && previous.cameraPermission.includes('QR') ? previous.cameraPermission : CAMERA_PERMISSION,
    microphonePermission: false, recordAudioAndroid: false }];
  const source = bytes.toString('utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  return Buffer.from(bom + JSON.stringify(next, null, 2).replace(/\n/g, eol) + (/[\r\n]$/.test(source) ? eol : ''));
}

export const NATIVE_CHECK_SOURCE = String.raw`
const assert = require('node:assert/strict');
const { getPrebuildConfigAsync } = require('@expo/prebuild-config');
const { compileModsAsync } = require('expo/config-plugins');
(async () => {
  const { exp } = await getPrebuildConfigAsync(process.cwd(), { platforms: ['ios'] });
  assert.equal(exp.extra?.eas?.projectId, 'b84c88d0-b923-4a2a-b144-9fe5f0528f8d');
  assert.equal(exp.ios?.bundleIdentifier, 'jp.oneeight.tamaya.members');
  assert.equal(exp.version, '1.0.0');
  const compiled = await compileModsAsync(exp, { projectRoot: process.cwd(), platforms: ['ios'], introspect: true });
  const plist = compiled._internal?.modResults?.ios?.infoPlist;
  assert.ok(plist && typeof plist === 'object');
  assert.equal(Object.hasOwn(plist, 'NSMicrophoneUsageDescription'), false);
  assert.equal(typeof plist.NSCameraUsageDescription, 'string');
  assert.ok(plist.NSCameraUsageDescription.includes('QR'));
  assert.equal(plist.ITSAppUsesNonExemptEncryption, false);
  assert.notEqual(compiled._internal?.modResults?.ios?.podfileProperties?.['expo.camera.barcode-scanner-enabled'], 'false');
})().catch(() => { process.exitCode = 1; });
`;

function runProcess(command, args, { root, env, capture = false }) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: capture });
    if (capture) { child.stdout.resume(); child.stderr.resume(); }
    const timer = capture ? setTimeout(() => child.kill(), 90_000) : null;
    child.once('error', () => { clearTimeout(timer); reject(new Error('process failed')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('process failed')); });
  });
}

export function repairBuildArguments(submit = false) {
  return ['eas-cli@25.3.0', 'build', '--platform', 'ios', '--profile', 'production', '--non-interactive', '--clear-cache',
    ...(submit ? ['--auto-submit-with-profile', 'production'] : [])];
}

async function executeAction(action, { root, env, submit }) {
  if (action === 'check') return runProcess(process.execPath, ['scripts/release-check.mjs'], { root, env, capture: true });
  if (action === 'nativecheck') return runProcess(process.execPath, ['--input-type=commonjs', '-e', NATIVE_CHECK_SOURCE], {
    root, env: { ...env, EAS_BUILD_PROFILE: 'production', EXPO_OFFLINE: '1', CI: '1' }, capture: true });
  if (action !== 'build') throw fail('実行する処理を確認できません。');
  const args = repairBuildArguments(submit);
  return process.platform === 'win32'
    ? runProcess('cmd.exe', ['/d', '/s', '/c', `npx ${args.join(' ')}`], { root, env })
    : runProcess('npx', args, { root, env });
}

async function downloadFile({ url, destination }) {
  await new Promise((accept, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--silent', '--show-error',
      '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180',
      url, '--output', destination], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error('download failed')));
    child.once('close', code => code === 0 ? accept() : reject(new Error('download failed')));
  });
}

async function atomicWrite(root, path, bytes, mode) {
  const name = `.env.ios-permission-${randomUUID()}.tmp`;
  const temporary = join(root, name);
  try {
    await checkIgnores(root, name);
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function repairIosPermissions({ root = process.cwd(), localOnly = false, build = false, submit = false,
  download = downloadFile, execute = executeAction, log = console.log, files = REPAIR_FILES, ref = REPAIR_REF } = {}) {
  if (localOnly && build) throw fail('--local-onlyと--buildは同時に指定できません。');
  if (submit && !build) throw fail('--submitは--buildと一緒に指定してください。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw fail('Node.js 24以降で実行してください。');
  if (!/^[a-f0-9]{40}$/.test(ref) || files.length !== REPAIR_FILES.length
    || files.some((file, index) => file.path !== REPAIR_FILES[index].path || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw fail('検証済みの修正ファイル一覧を確認できません。');
  }
  root = await realpath(resolve(root));
  const { appBytes } = await validateProject(root);
  const changes = [{ relative: 'app.json', next: patchCameraConfiguration(appBytes) }];
  const stage = await mkdtemp(join(tmpdir(), 'tamaya-ios-permission-'));
  try {
    log('1/3 マイクを使わない修正ファイルを取得・照合します。');
    for (const [index, file] of files.entries()) {
      const destination = join(stage, `${index}.download`);
      try { await download({ url: `https://raw.githubusercontent.com/iichi86/tamayaapp/${ref}/${file.path}`, destination }); }
      catch { throw fail('修正ファイルを取得できませんでした。PCの設定は変更していません。'); }
      const bytes = await readFile(destination);
      if (!bytes.length || digest(bytes) !== file.sha256) throw fail('取得した修正ファイルが検証済みの版と一致しません。変更せず終了します。');
      changes.push({ relative: file.path, next: bytes });
    }
    for (const change of changes) {
      const path = await safePath(root, change.relative);
      const info = await lstat(path);
      change.previous = await readFile(path); change.mode = info.mode & 0o777;
      if (!change.previous.length) throw fail('更新前のソースファイルが空のため変更しません。');
    }
    if (!same(changes[0].previous, appBytes)) throw fail('アプリ設定が処理中に変更されました。変更せず再実行してください。');
    await validateProject(root);
    const env = { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root,
      DISABLE_EAS_ANALYTICS: '1', EXPO_NO_TELEMETRY: '1', EXPO_IOS_BUNDLE_IDENTIFIER: BUNDLE_ID };
    const applied = [];
    try {
      log('2/3 PCのカメラ設定を修正し、生成されるiOS設定を確認します。');
      for (const change of changes) {
        const path = await safePath(root, change.relative);
        if (!same(await readFile(path), change.previous)) throw fail('ソースが処理中に変更されました。');
        await atomicWrite(root, path, change.next, change.mode); applied.push(change);
      }
      await execute('check', { root, env });
      await execute('nativecheck', { root, env });
      for (const change of changes) if (!same(await readFile(await safePath(root, change.relative)), change.next)) throw fail('確認中にソースが変更されました。');
    } catch {
      let restored = true;
      for (const change of applied.reverse()) {
        try {
          const path = await safePath(root, change.relative);
          if (!same(await readFile(path), change.next)) { restored = false; continue; }
          await atomicWrite(root, path, change.previous, change.mode);
        } catch { restored = false; }
      }
      throw fail(restored ? '設定とiOS権限の確認を完了できなかったため、PCの変更を元に戻しました。Appleへの送信は実行していません。'
        : '確認処理が中断されました。他の変更を保護するため一部を復元していません。Appleへの送信は実行していません。');
    }
    log('生成されるiOS設定にマイク権限がなく、QR用カメラ説明が残ることを確認しました。');
    if (localOnly || !build) { log('PCの修正と確認が完了しました。'); return; }
    log('3/3 保存済みのEAS認証情報で、修正版のiPhoneビルドを開始します。');
    try { await execute('build', { root, env, submit }); }
    catch { throw fail('PCの修正は完了しています。EASのビルド・アップロードを完了できませんでした。表示されたEASの結果を確認してください。'); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--local-only', '--build', '--submit', '--help'].includes(arg))) {
    console.error('使い方: node scripts/repair-ios-permissions.mjs --build --submit'); process.exitCode = 1;
  } else if (args.includes('--help')) {
    console.log('node scripts/repair-ios-permissions.mjs --build --submit\n未使用マイク権限を削除し、生成されるiOS設定を確認して、再ビルドと成功後のアップロードへ進みます。\n--local-only: PCの修正と権限確認まで。App Reviewへの再提出は実行しません。');
  } else {
    await repairIosPermissions({ localOnly: args.includes('--local-only'), build: args.includes('--build'), submit: args.includes('--submit') })
      .catch(error => { console.error(error instanceof IosPermissionRepairError ? error.message : '修正処理を完了できませんでした。ファイルと通信状態を確認してください。'); process.exitCode = 1; });
  }
}
