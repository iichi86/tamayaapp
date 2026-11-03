import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, rename, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const RELEASE_REF = 'b87b70a43160524e2920882b84aabd66fd0d0ecf';
export const PROJECT_ID = 'b84c88d0-b923-4a2a-b144-9fe5f0528f8d';
export const BUNDLE_ID = 'jp.oneeight.tamaya.members';
export const RELEASE_FILES = Object.freeze([
  ['app.json', '1776fbba17b1e1a89f0c3f0bd6412be7da558617272ac2c7422f73fe4aa99559'],
  ['app.config.ts', 'b188ef8ba031f94333ea79ac34d8423d50bd550266c0241372266e2820a73a17'],
  ['.easignore', '75d47a626317bc3e5375f4300ace6a5ef964e8a3f27f546f53930531b9d484d9'],
  ['eas.json', 'e2892dc156cebbcfe0bbede009479fa4ac80a0c5d550294e7c3bd63711974347'],
  ['server/config/tamaya.json', '6fe84a3e9f70a48793a192076098869200432f67c35a29e2ab5d88aca93ba691'],
  ['assets/app-icon.png', '28d3be26636777f4bfce47eb3e38e1411384f8fabe809eaac5c800fcfcc66fcc'],
].map(([path, sha256]) => Object.freeze({ path, sha256 })));

// Only these two public settings are changed. All other .env text stays opaque.
const updates = { RELEASE_BUSINESS_APPROVED: '1', EXPO_IOS_BUNDLE_IDENTIFIER: BUNDLE_ID };

function closingQuote(text, quote, start = 0) {
  // Node's dotenv parser treats the first same quote as the closing delimiter,
  // including a quote preceded by a backslash (for single, double and backtick).
  return text.indexOf(quote, start);
}

export function updateEnvironment(input) {
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = input.slice(bom.length);
  const previousValues = parseEnv(body);
  if (previousValues.EAS_PROJECT_ID && previousValues.EAS_PROJECT_ID !== PROJECT_ID) {
    throw new Error('.envのEASプロジェクトが今回のアプリと一致しません。');
  }
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const eol = lines.map(line => line.match(/(\r\n|\n|\r)$/)?.[0]).find(Boolean) ?? '\n';
  const seen = new Set();
  let multilineQuote = null;
  const output = lines.map(line => {
    const ending = line.match(/(\r\n|\n|\r)$/)?.[0] ?? '';
    const content = ending ? line.slice(0, -ending.length) : line;
    if (multilineQuote) {
      if (closingQuote(content, multilineQuote) >= 0) multilineQuote = null;
      return line;
    }
    const assignment = content.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) return line;
    const [, key, value] = assignment;
    const quote = ['"', "'", '`'].includes(value[0]) ? value[0] : null;
    if (quote && closingQuote(value, quote, 1) < 0) multilineQuote = quote;
    if (key === 'EAS_PROJECT_ID' || Object.hasOwn(updates, key)) {
      if (seen.has(key)) throw new Error(`.envの${key}が重複しています。1行に整理してから再実行してください。`);
      seen.add(key);
      if (multilineQuote) throw new Error(`.envの${key}は1行の値にしてください。`);
    }
    if (key === 'EAS_PROJECT_ID') {
      const projectId = parseEnv(content).EAS_PROJECT_ID;
      if (projectId && projectId !== PROJECT_ID) throw new Error('.envのEASプロジェクトが今回のアプリと一致しません。');
    }
    return Object.hasOwn(updates, key) ? `${key}=${updates[key]}${ending}` : line;
  });
  if (multilineQuote) throw new Error('.envの引用符が閉じていません。変更せず終了します。');
  let result = output.join('');
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (result && !/[\r\n]$/.test(result)) result += eol;
    result += `${key}=${value}${eol}`;
  }
  const nextValues = parseEnv(result);
  if (Object.entries(updates).some(([key, value]) => nextValues[key] !== value)
    || [...new Set([...Object.keys(previousValues), ...Object.keys(nextValues)])]
      .some(key => !Object.hasOwn(updates, key) && previousValues[key] !== nextValues[key])) {
    throw new Error('.envの他の設定を保ったまま更新できません。変更せず終了します。');
  }
  return bom + result;
}

async function safePath(root, relative, missingLeaf = false) {
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && index === parts.length - 1) return current;
      throw new Error(`保存先${relative}を確認できません。今回のアプリ直下で実行してください。`);
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`保存先${relative}にリンクまたは通常でないファイルがあるため変更しません。`);
    }
  }
  return current;
}

async function validateProject(root) {
  for (const path of ['package.json', 'app.json', '.env', 'scripts/release-check.mjs']) await safePath(root, path);
  let pkg, app;
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
  } catch { throw new Error('今回のアプリの設定ファイルを読み取れません。'); }
  if (pkg.name !== 'tamaya-members-demo' || !/^[~^]?58\./.test(pkg.dependencies?.expo ?? '')
    || app?.owner !== 'oneight' || app?.extra?.eas?.projectId !== PROJECT_ID) {
    throw new Error('玉屋のSDK 58・登録済みEASプロジェクトのフォルダーで実行してください。');
  }
  if (process.env.EAS_PROJECT_ID && process.env.EAS_PROJECT_ID !== PROJECT_ID) {
    throw new Error('黒い画面のEAS_PROJECT_IDが今回のアプリと一致しません。');
  }
  for (const { path } of RELEASE_FILES) await safePath(root, path, true);
}

function runProcess(command, args, { cwd, env = process.env } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: false });
    child.once('error', () => reject(new Error(`${command}を起動できませんでした。`)));
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`処理が${signal ?? `終了コード${code}`}で停止しました。`)));
  });
}

async function downloadFile({ url, destination }) {
  await runProcess(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '3',
    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180',
    url, '--output', destination,
  ]);
}

export async function verifyPublicBackend({ stage, expectedStore, download = downloadFile }) {
  const responses = [];
  for (const [index, path] of ['/health', '/v1/stores/tamaya'].entries()) {
    const destination = join(stage, `public-backend-${index}.json`);
    await download({ url: `https://tamayaapp.onrender.com${path}`, destination });
    try { responses.push(JSON.parse(await readFile(destination, 'utf8'))); }
    catch { throw new Error('公開サーバーの応答を確認できませんでした。'); }
  }
  const [health, store] = responses;
  if (health.status !== 'ok' || health.authMode !== 'firebase' || store.id !== 'tamaya'
    || ['termsVersion', 'privacyVersion', 'termsText', 'privacyText', 'supportText']
      .some(key => store.legal?.[key] !== expectedStore.legal?.[key])) {
    throw new Error('公開サーバーの起動状態または正式文面への反映をまだ確認できません。');
  }
}

export function easArguments(action, submit = false) {
  if (action === 'approval') return ['eas-cli@25.3.0', 'env:set', 'production', '--name', 'RELEASE_BUSINESS_APPROVED', '--value', '1', '--visibility', 'sensitive', '--scope', 'project', '--non-interactive'];
  if (action === 'build') return ['eas-cli@25.3.0', 'build', '--platform', 'ios', '--profile', 'production',
    ...(submit ? ['--auto-submit-with-profile', 'production'] : [])];
  throw new Error('実行するEAS処理が正しくありません。');
}

async function runAction(action, { root, env, submit = false }) {
  if (action === 'check') return runProcess(process.execPath, ['scripts/release-check.mjs'], { cwd: root, env });
  // Every shell argument is fixed here; paths and environment contents are never interpolated.
  const args = easArguments(action, submit);
  if (process.platform === 'win32') return runProcess('cmd.exe', ['/d', '/s', '/c', `npx ${args.join(' ')}`], { cwd: root, env });
  return runProcess('npx', args, { cwd: root, env });
}

async function atomicWrite(path, bytes, mode = 0o600) {
  // Intermediate .env bytes remain excluded from both Git and EAS if interrupted.
  const temporary = join(dirname(path), `.env.tamaya-update-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function prepareIosBuild({ root = process.cwd(), localOnly = false, build = false, submit = false,
  download = downloadFile, execute = runAction, verifyBackend = verifyPublicBackend,
  log = console.log, files = RELEASE_FILES } = {}) {
  if (localOnly && build) throw new Error('--local-onlyと--buildは同時に指定できません。');
  if (submit && (!build || localOnly)) throw new Error('--submitは--buildと一緒に指定してください。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24以降で実行してください。');
  if (files.length !== RELEASE_FILES.length || files.some((entry, index) => entry.path !== RELEASE_FILES[index].path || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
    throw new Error('更新対象の公開ファイル一覧が正しくありません。');
  }
  root = await realpath(resolve(root));
  await validateProject(root);
  const envPath = join(root, '.env');
  const previousEnv = await readFile(envPath);
  const envText = previousEnv.toString('utf8');
  if (!Buffer.from(envText).equals(previousEnv) || envText.includes('\0')) {
    throw new Error('.envがUTF-8ではないため、内容を変更せず終了します。');
  }
  const nextEnv = Buffer.from(updateEnvironment(envText));
  const stage = await mkdtemp(join(tmpdir(), 'tamaya-ios-inputs-'));
  const changes = [];
  try {
    log('1/3 公開ファイルを取得・照合しています。');
    for (const [index, entry] of files.entries()) {
      const destination = join(stage, `${index}.download`);
      await download({ url: `https://raw.githubusercontent.com/iichi86/tamayaapp/${RELEASE_REF}/${entry.path}`, destination });
      const next = await readFile(destination);
      if (createHash('sha256').update(next).digest('hex') !== entry.sha256) throw new Error(`${entry.path}の取得内容が検証済みの版と一致しません。変更せず終了します。`);
      changes.push({ relative: entry.path, next });
    }
    changes.push({ relative: '.env', next: nextEnv });
    for (const change of changes) {
      const path = await safePath(root, change.relative, true);
      try { change.previous = await readFile(path); change.mode = (await stat(path)).mode & 0o777; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Another editor may have changed .env while the public files were downloading.
    if (!changes.at(-1).previous?.equals(previousEnv)) throw new Error('.envが処理中に変更されました。変更せず再実行してください。');
    const env = { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root,
      EXPO_IOS_BUNDLE_IDENTIFIER: BUNDLE_ID, RELEASE_BUSINESS_APPROVED: '1' };
    const applied = [];
    try {
      log('2/3 PCの設定を更新し、配布前チェックを実行します。');
      for (const change of changes) {
        const path = await safePath(root, change.relative, true);
        await atomicWrite(path, change.next, change.mode);
        applied.push(change);
      }
      await execute('check', { root, env });
    } catch (error) {
      let restoreFailed = false;
      for (const change of applied.reverse()) {
        try {
          const path = await safePath(root, change.relative, true);
          if (change.previous) await atomicWrite(path, change.previous, change.mode);
          else await rm(path, { force: true });
        } catch { restoreFailed = true; }
      }
      throw new Error(restoreFailed ? 'PC更新中に停止し、一部を復元できませんでした。表示された画面を担当者へ伝えてください。'
        : `PCの変更を元に戻しました。${error.message}`);
    }
    if (localOnly) { log('PCの更新と設定チェックが完了しました。'); return; }
    log('公開サーバーの起動と正式文面を確認します。');
    try {
      await verifyBackend({ stage, download,
        expectedStore: JSON.parse(changes.find(change => change.relative === 'server/config/tamaya.json').next) });
    } catch {
      throw new Error('PCの更新は完了しました。公開サーバーへの正式設定の反映を確認できないため、少し待って同じコマンドを再実行してください。');
    }
    log('3/3 EASの承認設定を更新します。');
    try { await execute('approval', { root, env }); }
    catch { throw new Error('PCの更新は完了しました。EASの設定更新が完了していないため、同じコマンドを再実行してください。'); }
    if (build) {
      log(submit ? 'iPhoneアプリの作成と、成功後のTestFlightアップロードを開始します。Appleの確認は、この黒い画面で操作してください。'
        : 'iPhoneアプリのビルドを開始します。Appleの確認は、この黒い画面で操作してください。');
      await execute('build', { root, env, submit });
    } else log('準備が完了しました。次に同じコマンドへ--buildを付けてビルドへ進めます。');
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--local-only', '--build', '--submit', '--help'].includes(arg))) {
    console.error('使い方: node scripts/prepare-ios-build.mjs [--build [--submit] | --local-only]'); process.exitCode = 1;
  } else if (args.includes('--help')) {
    console.log('node scripts/prepare-ios-build.mjs --build --submit\n公開ファイル・PCとEASの承認設定を更新し、署名付きiOSビルドと成功後のTestFlightアップロードへ進みます。\n--buildのみ: ビルドまで実行します。\n--local-only: 公開サーバーやEASへ接続せず、PCの更新と設定チェックだけを実行します。');
  } else {
    await prepareIosBuild({ build: args.includes('--build'), submit: args.includes('--submit'), localOnly: args.includes('--local-only') })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
