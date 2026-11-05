import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const PROJECT_ID = 'b84c88d0-b923-4a2a-b144-9fe5f0528f8d';
export const BUNDLE_ID = 'jp.oneeight.tamaya.members';
export const APP_ID = '6830628549';
export const PRIVATE_FILE = '.env.store.config.json';
const TEMP_PROBE = '.env.metadata-update-00000000-0000-4000-8000-000000000000.tmp';
export const TEMPLATE_URL = 'https://raw.githubusercontent.com/iichi86/tamayaapp/6ffe8dfb9391e5a633eafb31d9462c53dc2a43ae/deployment/store.config.json';
export const TEMPLATE_SHA256 = '6a7d12f22d276b787239f49fd45e820da5b4f70bf6b68d6f9cdceb489b81c92f';
const PUBLIC_FIELDS = ['title', 'subtitle', 'description', 'keywords', 'promoText', 'supportUrl', 'privacyPolicyUrl'];
const DEFAULT_NOTES = '本アプリは、東京都中野区の実店舗「むさしの玉屋」の無料会員サービスです。一般会員向けにホーム、会員証、特典、店舗情報を提供します。\n\n会員登録はメールアドレスとパスワードで行い、登録メールの確認後にニックネームを登録します。同じアカウントで機種変更後も会員情報を利用できます。\n\n生菓子・ギフト商品が対象の500円以上のお会計について、店舗スタッフが確認して1スタンプを付与します。同じ会員につき日本時間で1日1回です。5個を消費すると、スタッフが当日の対象商品から選ぶ生菓子1つの特典を発行します。有効期間は発行から90日間、交換時の追加購入は不要で、他の割引・クーポンと併用できます。\n\nカメラはスタッフが会員QRコードを読み取るために使用します。QRの読取りだけではスタンプは付きません。写真・動画の保存や映像送信は行いません。スタッフ用機能は、オーナーが権限を付けたアカウントに表示されます。\n\nアプリ内に商品の購入・課金機能はありません。会計と特典の受取りは実店舗で行います。アプリの「設定」から、現在のパスワードによる本人確認を伴う退会・アカウント削除を申請できます。';

export class MetadataPreparationError extends Error {}
const fail = message => new MetadataPreparationError(message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && !!value.trim();

async function safeFile(root, relative, missing = false) {
  const path = join(root, relative);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw fail(`${relative}が通常のファイルではないため変更しません。`);
  } catch (error) {
    if (missing && error.code === 'ENOENT') return path;
    if (error instanceof MetadataPreparationError) throw error;
    throw fail('今回のアプリ直下の必要なファイルを確認できません。');
  }
  return path;
}

function parseJson(bytes) {
  try {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error();
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(value)) throw new Error();
    return value;
  } catch { throw fail('設定JSONを読み取れません。内容を変更せず終了します。'); }
}

// The private file is a root-level filename. Apply root-file ignore rules in order.
export function isPrivateFileIgnored(contents, filename = PRIVATE_FILE) {
  if (typeof filename !== 'string' || !filename || /[/\\]/.test(filename)) return false;
  let ignored = false;
  for (let pattern of contents.split(/\r?\n/).map(line => line.trim())) {
    if (!pattern || pattern.startsWith('#')) continue;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    pattern = pattern.replace(/^\//, '').replace(/^\*\*\//, '');
    // Fail closed for unignore syntax outside this root-file glob subset.
    if (negate && (/[\[\]\\]/.test(pattern) || pattern.includes('**'))) return false;
    if (pattern.includes('/') || pattern.includes('\\')) continue;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (new RegExp(`^${escaped}$`).test(filename)) ignored = !negate;
  }
  return ignored;
}

async function verifyIgnoreProtection(root, extraFilename) {
  const filenames = [PRIVATE_FILE, TEMP_PROBE, ...(extraFilename ? [extraFilename] : [])];
  for (const path of ['.gitignore', '.easignore']) {
    const ignore = await readFile(await safeFile(root, path), 'utf8');
    if (filenames.some(filename => !isPrivateFileIgnored(ignore, filename))) {
      throw fail('非公開設定と作業用ファイルをGitとEASから除外する設定を確認できないため、保存しません。');
    }
  }
}

async function validateProject(root) {
  const pkg = parseJson(await readFile(await safeFile(root, 'package.json')));
  const app = parseJson(await readFile(await safeFile(root, 'app.json'))).expo;
  const easPath = await safeFile(root, 'eas.json');
  const easBytes = await readFile(easPath);
  const eas = parseJson(easBytes);
  if (pkg.name !== 'tamaya-members-demo' || app?.owner !== 'oneight'
    || app?.extra?.eas?.projectId !== PROJECT_ID || app?.ios?.bundleIdentifier !== BUNDLE_ID
    || app?.version !== '1.0.0' || !object(eas.submit?.production?.ios)) {
    throw fail('今回の玉屋アプリ1.0.0・登録済みプロジェクトのフォルダーで実行してください。');
  }
  const ios = eas.submit.production.ios;
  if ((ios.bundleIdentifier && ios.bundleIdentifier !== BUNDLE_ID) || (ios.ascAppId && ios.ascAppId !== APP_ID)
    || (process.env.EAS_PROJECT_ID && process.env.EAS_PROJECT_ID !== PROJECT_ID)) {
    throw fail('公開先のアプリが今回の登録内容と一致しません。');
  }
  if (ios.metadataPath && ios.metadataPath !== PRIVATE_FILE) {
    throw fail('既存の掲載設定の保存先が異なるため、変更せず終了します。');
  }
  await verifyIgnoreProtection(root);
  await safeFile(root, PRIVATE_FILE, true);
  return { eas, easBytes, easMode: (await stat(easPath)).mode & 0o777 };
}

export function mergePublicMetadata(existing, template) {
  if (template.configVersion !== 0 || template.apple?.version !== '1.0.0'
    || template.apple?.info?.ja?.title !== 'むさしの玉屋') throw fail('公開用の掲載設定の版を確認できません。');
  if ((existing.configVersion !== undefined && existing.configVersion !== 0)
    || (existing.apple !== undefined && !object(existing.apple))
    || (existing.apple?.version !== undefined && existing.apple.version !== '1.0.0')) {
    throw fail('既存の掲載設定が今回の1.0.0と異なります。上書きせず終了します。');
  }
  const next = structuredClone(existing);
  next.configVersion = 0;
  next.apple ??= {};
  next.apple.version = '1.0.0';
  if ((next.apple.info !== undefined && !object(next.apple.info))
    || (next.apple.info?.ja !== undefined && !object(next.apple.info.ja))
    || (next.apple.review !== undefined && !object(next.apple.review))) {
    throw fail('既存の掲載設定の構造を確認できません。上書きせず終了します。');
  }
  next.apple.info ??= {};
  next.apple.info.ja ??= {};
  for (const key of PUBLIC_FIELDS) {
    if (template.apple.info.ja[key] === undefined) throw fail('公開用の掲載文に不足があります。');
    next.apple.info.ja[key] = structuredClone(template.apple.info.ja[key]);
  }
  return next;
}

function validText(value) { return nonempty(value) && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value); }
const fields = [
  { key: 'copyright', label: '著作権表記（候補は2026 ワンエイト。実際の権利者が異なる場合は入力）', defaultValue: '2026 ワンエイト', valid: value => validText(value) && !/https?:\/\//i.test(value) },
  { key: 'lastName', label: 'Apple審査の連絡先：姓（PC内へ保存）', valid: validText },
  { key: 'firstName', label: 'Apple審査の連絡先：名（PC内へ保存）', valid: validText },
  { key: 'email', label: 'Apple審査の連絡先：メールアドレス（PC内へ保存）', valid: value => validText(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) },
  { key: 'phone', label: 'Apple審査の連絡先：電話番号（国番号から入力）', defaultValue: '+818049097012', valid: value => validText(value) },
];

export async function fillContact(metadata, { ask, edit = false, log = console.log }) {
  metadata.apple.review ??= {};
  const review = metadata.apple.review;
  for (const field of fields) {
    const container = field.key === 'copyright' ? metadata.apple : review;
    const current = container[field.key];
    if (field.valid(current) && !edit) continue;
    // The provided service phone is already confirmed; it can be changed with --edit.
    if (field.key === 'phone' && current === undefined && !edit) {
      container.phone = field.defaultValue;
      continue;
    }
    const defaultValue = field.valid(current) ? current : field.defaultValue;
    for (;;) {
      const response = await ask({ field: field.key, label: field.label, defaultValue,
        preserveCurrent: field.valid(current) });
      if (typeof response !== 'string') throw fail('入力が完了していないため、保存せず終了します。');
      const answer = response.trim();
      const value = answer || defaultValue;
      if (field.valid(value)) { container[field.key] = value; break; }
      log(`${field.key}の入力を確認してください。空欄や制御文字を含む値は保存できません。`);
    }
  }
  review.demoRequired = true;
  if (!nonempty(review.notes)) review.notes = DEFAULT_NOTES;
  return metadata;
}

async function downloadTemplate({ url, destination }) {
  await new Promise((accept, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180',
      url, '--output', destination,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => reject(fail('掲載用の公開設定を取得できませんでした。')));
    child.once('exit', code => code === 0 ? accept() : reject(fail('掲載用の公開設定を取得できませんでした。')));
  });
}

export async function lintMetadata({ root }) {
  const args = ['eas-cli@25.3.0', 'metadata:lint', '--profile', 'production', '--json'];
  return await new Promise((accept, reject) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `npx ${args.join(' ')}`] : args;
    const child = spawn(command, commandArgs, { cwd: root,
      env: { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root,
        EXPO_NO_TELEMETRY: '1', DISABLE_EAS_ANALYTICS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 256_000) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.resume(); // Never echo validation output which may contain private values.
    child.once('error', () => { clearTimeout(timer); reject(fail('掲載設定のローカル検証を起動できませんでした。')); });
    child.once('close', code => {
      clearTimeout(timer);
      return code === 0 && size <= 256_000 ? accept(Buffer.concat(stdout).toString('utf8'))
        : reject(fail('掲載設定のローカル検証を完了できませんでした。'));
    });
  });
}

async function atomicWrite(path, bytes, mode = 0o600) {
  const temporary = join(dirname(path), `.env.metadata-update-${randomUUID()}.tmp`);
  try {
    await verifyIgnoreProtection(dirname(path), basename(temporary));
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readOptional(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const sameBytes = (a, b) => a === null || b === null ? a === b : a.equals(b);

export async function prepareStoreMetadata({ root = process.cwd(), edit = false, ask,
  download = downloadTemplate, lint = lintMetadata, log = console.log } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw fail('Node.js 24以降で実行してください。');
  root = await realpath(resolve(root));
  const project = await validateProject(root);
  const privatePath = await safeFile(root, PRIVATE_FILE, true);
  const previousPrivate = await readOptional(privatePath);
  const previousMode = previousPrivate === null ? undefined : (await stat(privatePath)).mode & 0o777;
  const existing = previousPrivate === null ? {} : parseJson(previousPrivate);
  const stage = await mkdtemp(join(tmpdir(), 'tamaya-store-metadata-'));
  try {
    const destination = join(stage, 'public-template.json');
    log('掲載用の公開設定を取得・照合します。');
    try { await download({ url: TEMPLATE_URL, destination }); }
    catch { throw fail('掲載用の公開設定を取得できませんでした。PCの設定は変更していません。'); }
    const templateBytes = await readFile(destination);
    if (createHash('sha256').update(templateBytes).digest('hex') !== TEMPLATE_SHA256) {
      throw fail('取得した公開設定が検証済みの版と一致しません。変更せず終了します。');
    }
    const metadata = mergePublicMetadata(existing, parseJson(templateBytes));
    if (!ask) throw fail('入力方法を確認できません。黒い画面から実行してください。');
    log('不足している連絡先だけ入力します。入力内容はPC内の非公開ファイルへ保存します。');
    await fillContact(metadata, { ask, edit, log });
    // Prompts may remain open for a while; recheck identity and ignore protection.
    await validateProject(root);
    const nextPrivate = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
    const eas = structuredClone(project.eas);
    eas.submit.production.ios.ascAppId = APP_ID;
    eas.submit.production.ios.metadataPath = PRIVATE_FILE;
    const nextEas = Buffer.from(JSON.stringify(eas, null, 2) + '\n');
    const changes = [
      { relative: PRIVATE_FILE, previous: previousPrivate, next: nextPrivate, mode: 0o600, previousMode },
      { relative: 'eas.json', previous: project.easBytes, next: nextEas, mode: project.easMode, previousMode: project.easMode },
    ];
    const applied = [];
    try {
      for (const change of changes) {
        const path = await safeFile(root, change.relative, true);
        if (!sameBytes(await readOptional(path), change.previous)) throw fail('設定が処理中に変更されました。保存せず再実行してください。');
        await atomicWrite(path, change.next, change.mode);
        applied.push(change);
      }
      // EAS lint can report [] for missing config; independently verify the exact file and pointer.
      const written = parseJson(await readFile(await safeFile(root, 'eas.json')));
      const writtenPrivate = await readFile(await safeFile(root, PRIVATE_FILE));
      if (written.submit?.production?.ios?.metadataPath !== PRIVATE_FILE || !writtenPrivate.equals(nextPrivate)) {
        throw fail('保存した掲載設定の参照先を確認できません。');
      }
      let result;
      try { result = JSON.parse(String(await lint({ root })).trim()); }
      catch { throw fail('掲載設定のローカル検証を完了できませんでした。'); }
      if (!Array.isArray(result) || result.length !== 0) throw fail('掲載設定のローカル検証で問題が見つかりました。');
      for (const change of changes) {
        if (!sameBytes(await readOptional(await safeFile(root, change.relative)), change.next)) {
          throw fail('設定が検証中に変更されました。保存内容を確認してください。');
        }
      }
    } catch {
      let restored = true;
      for (const change of applied.reverse()) {
        try {
          const path = await safeFile(root, change.relative, true);
          if (!sameBytes(await readOptional(path), change.next)) { restored = false; continue; }
          if (change.previous === null) await rm(path, { force: true });
          else await atomicWrite(path, change.previous, change.previousMode);
        } catch { restored = false; }
      }
      throw fail(restored ? '掲載設定の検証を完了できなかったため、PCの変更を元に戻しました。'
        : '掲載設定の処理が中断されました。他の変更を保護するため一部を復元していません。');
    }
    log('掲載文と連絡先の設定をPC内へ保存し、ローカル検証が成功しました。');
    const hasDemoCredentials = nonempty(metadata.apple.review.demoUsername) && nonempty(metadata.apple.review.demoPassword);
    if (!hasDemoCredentials) log('審査用アカウントのログイン情報は未設定です。審査へ提出する準備はまだ完了していません。');
    log('Appleへの同期・審査提出は、このコマンドでは実行していません。');
    return { privatePath, hasDemoCredentials };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--edit', '--help'].includes(arg))) throw fail('使い方: node scripts/prepare-store-metadata.mjs [--edit]');
  if (args.includes('--help')) {
    console.log('node scripts/prepare-store-metadata.mjs\n掲載文と審査連絡先をPC内の非公開設定へ用意し、ローカル検証します。\n--edit: 保存済みの連絡先を変更します。Appleへの同期や審査提出は実行しません。');
    return;
  }
  let terminal;
  try {
    await prepareStoreMetadata({ edit: args.includes('--edit'), ask: async ({ label, defaultValue, preserveCurrent }) => {
      if (!process.stdin.isTTY) throw fail('入力できる黒い画面から実行してください。');
      terminal ??= createInterface({ input: process.stdin, output: process.stdout });
      const suffix = preserveCurrent ? '（Enterで現在の値を保持）' : defaultValue ? '（Enterで候補を使用）' : '';
      return await terminal.question(`${label}${suffix}: `);
    } });
  } finally { terminal?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error instanceof MetadataPreparationError ? error.message : '掲載設定の準備を完了できませんでした。保存先と通信状態を確認してください。');
    process.exitCode = 1;
  });
}
