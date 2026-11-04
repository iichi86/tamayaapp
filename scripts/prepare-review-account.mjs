import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REVIEW_PROJECT_ID = 'tamayaapp';
export const REVIEW_EAS_PROJECT_ID = 'b84c88d0-b923-4a2a-b144-9fe5f0528f8d';
export const REVIEW_JOURNAL = '.env.review-account.json';
export const REVIEW_METADATA = '.env.store.config.json';
export const REVIEW_ACCESS_NOTE = '【審査専用アカウントについて】\nこの専用アカウントは管理SDKでメール確認済みとして用意しています。通常のお客様のメール確認要件は変更していません。予約ドメイン .invalid の識別子を使うため、このアカウントでは確認メール・パスワード再設定メールの受信はできません。\n一般会員として初回登録時は0スタンプ・特典なしで、スタッフ権限はありません。この準備処理で購入・来店記録や残高・特典を追加していません。特典詳細・交換、スタッフのカメラ・スタンプ付与を確認する方法は、この一般会員のログイン情報だけでは用意されていません。';
const API = 'https://tamayaapp.onrender.com';
const VERSION = '2026-11-04-1';
const TEMPLATE_REF = '6ffe8dfb9391e5a633eafb31d9462c53dc2a43ae';
const TEMPLATE_HASH = '6a7d12f22d276b787239f49fd45e820da5b4f70bf6b68d6f9cdceb489b81c92f';
const phases = ['intent', 'created', 'registered'];
const messages = {
  REVIEW_PROJECT: '今回の玉屋アプリのフォルダーと接続設定を確認してください。',
  REVIEW_PRIVATE_FILE: 'PC内の審査用設定ファイルを確認できません。内容を共有せず担当者へ伝えてください。',
  REVIEW_IGNORE: '審査用の非公開ファイルをGitとEASから除外する設定を確認できないため、保存しません。',
  REVIEW_CONFLICT: '既存の審査用設定と一致しません。既存の情報を変更せず終了しました。',
  REVIEW_CREDENTIALS: '正しいFirebase管理用JSONを選んでください。内容を共有する必要はありません。',
  REVIEW_CREDENTIALS_PROJECT: 'Firebase管理用JSONのプロジェクトが玉屋の設定と一致しません。',
  REVIEW_PICKER: '管理用JSONの選択画面を開けません。--credentialsでPC内の保存先を指定してください。',
  REVIEW_CANCELLED: 'ファイル選択がキャンセルされたため終了しました。',
  REVIEW_SDK: 'サーバー用Firebase SDKを読み込めません。担当者へこのコードを伝えてください。',
  REVIEW_TEMPLATE: '掲載用の公開設定を取得・検証できません。',
  REVIEW_BACKEND: '公開サーバーの正式な設定を確認できません。少し待って再実行してください。',
  REVIEW_AUTH: '審査用認証アカウントの準備を完了できません。同じコマンドで再試行できます。',
  REVIEW_ACCOUNT_CONFLICT: '対象の認証アカウントを審査用と確認できないため、変更せず終了しました。',
  REVIEW_ACCOUNT_MISSING: '作成済みの審査用認証アカウントが見つかりません。自動再作成せず終了しました。',
  REVIEW_LOGIN: '保存済みの審査用ログイン情報を確認できません。実際の会員のパスワードは入力しないでください。',
  REVIEW_REGISTER: '審査用会員の登録を完了できません。同じコマンドで再試行できます。',
  REVIEW_ROLE: '対象を一般会員として確認できません。スタッフ権限や残高は変更していません。',
};

export class ReviewAccountError extends Error {
  constructor(code) { super(`[${code}] ${messages[code]}`); this.code = code; }
}
const fail = code => { throw new ReviewAccountError(code); };
const utf8 = bytes => {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0')) fail('REVIEW_PRIVATE_FILE');
  return text.replace(/^\uFEFF/, '');
};

async function checkedPath(root, relative, missing = false) {
  let path = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (missing && error.code === 'ENOENT' && index === parts.length - 1) return path; fail('REVIEW_PRIVATE_FILE'); }
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) fail('REVIEW_PRIVATE_FILE');
  }
  return path;
}

async function privateJson(root, name) {
  const path = await checkedPath(root, name, true);
  try { return JSON.parse(utf8(await readFile(path))); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('REVIEW_PRIVATE_FILE'); }
}

// These files are all at the project root. Later matching negations override
// earlier rules, just as they do in .gitignore and .easignore.
export function isReviewPrivateFileIgnored(contents, filename) {
  let ignored = false;
  for (let pattern of contents.split(/\r?\n/).map(line => line.trim())) {
    if (!pattern || pattern.startsWith('#')) continue;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    pattern = pattern.replace(/^\//, '').replace(/^\*\*\//, '');
    // Unsupported unignore syntax could expose a private file: fail closed.
    if (negate && (/[\[\]\\]/.test(pattern) || pattern.includes('**'))) return false;
    if (pattern.includes('/') || pattern.includes('\\')) continue;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (new RegExp(`^${escaped}$`).test(filename)) ignored = !negate;
  }
  return ignored;
}

async function requirePrivateIgnores(root, names) {
  for (const path of ['.gitignore', '.easignore']) {
    const contents = utf8(await readFile(await checkedPath(root, path)));
    if (!names.every(name => isReviewPrivateFileIgnored(contents, name))) fail('REVIEW_IGNORE');
  }
}

async function savePrivate(root, name, value, exclusive = false) {
  const path = await checkedPath(root, name, true);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const temporaryName = `.env.review-update-${randomUUID()}.tmp`;
  // Recheck immediately before every write, including the actual random
  // temporary filename. Ignore files may have changed during network requests.
  await requirePrivateIgnores(root, [REVIEW_JOURNAL, REVIEW_METADATA, temporaryName]);
  if (exclusive) {
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return; }
    catch (error) { if (error.code === 'EEXIST') fail('REVIEW_CONFLICT'); fail('REVIEW_PRIVATE_FILE'); }
  }
  const temporary = join(root, temporaryName);
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  catch { fail('REVIEW_PRIVATE_FILE'); }
  finally { await rm(temporary, { force: true }); }
}

export function pickReviewCredentialsFile() {
  if (process.platform !== 'win32') fail('REVIEW_PICKER');
  let selected;
  try {
    selected = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = 'Firebase管理用JSONを選んでください'",
      "$dialog.Filter = 'Firebase管理用JSON (*.json)|*.json'",
      '$dialog.CheckFileExists = $true', '$dialog.Multiselect = $false',
      "$dialog.InitialDirectory = [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), 'Downloads')",
      'try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) } else { exit 3 } } finally { $dialog.Dispose() }',
    ].join('; ')], { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 }).trim();
  } catch (error) { fail(error.status === 3 ? 'REVIEW_CANCELLED' : 'REVIEW_PICKER'); }
  if (!selected || !win32.isAbsolute(selected) || !/\.json$/i.test(selected) || /[\x00-\x1f\x7f]/.test(selected)) fail('REVIEW_CREDENTIALS');
  return selected;
}

function firebaseAdmin({ root, account }) {
  try {
    const require = createRequire(join(root, 'server/package.json'));
    const { cert, initializeApp, deleteApp } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const app = initializeApp({ projectId: REVIEW_PROJECT_ID,
      credential: cert({ projectId: REVIEW_PROJECT_ID, clientEmail: account.client_email, privateKey: account.private_key }) }, `tamaya-review:${randomUUID()}`);
    return { auth: getAuth(app), close: () => deleteApp(app) };
  } catch { fail('REVIEW_SDK'); }
}

async function requestJson({ url, method = 'GET', headers = {}, body }) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(120000),
    headers: { Accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error('Remote request failed');
  return response.json();
}

async function downloadTemplate({ url, destination }) {
  await new Promise((accept, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '20', '--max-time', '180', url, '--output', destination,
    ], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('Download failed')));
  });
}

async function metadataTemplate(download) {
  const stage = await mkdtemp(join(tmpdir(), 'tamaya-review-public-'));
  try {
    const destination = join(stage, 'store.config.json');
    await download({ url: `https://raw.githubusercontent.com/iichi86/tamayaapp/${TEMPLATE_REF}/deployment/store.config.json`, destination });
    const bytes = await readFile(destination);
    if (createHash('sha256').update(bytes).digest('hex') !== TEMPLATE_HASH) fail('REVIEW_TEMPLATE');
    return JSON.parse(bytes.toString('utf8'));
  } catch { fail('REVIEW_TEMPLATE'); }
  finally { await rm(stage, { recursive: true, force: true }); }
}

function validateJournal(journal) {
  if (!journal || journal.version !== 1 || journal.projectId !== REVIEW_PROJECT_ID || journal.storeId !== 'tamaya'
    || !/^app-review-[a-f0-9-]{36}$/.test(journal.uid) || !/^app-review-[a-f0-9]{12}@tamaya-review\.invalid$/.test(journal.email)
    || typeof journal.password !== 'string' || journal.password.length < 24 || !phases.includes(journal.phase)
    || !/^[a-f0-9-]{36}$/.test(journal.markerNonce) || !/^[a-f0-9-]{36}$/.test(journal.registrationKey)) fail('REVIEW_CONFLICT');
}

function validateMetadata(metadata, journal) {
  if (!metadata || metadata.configVersion !== 0 || !metadata.apple || metadata.apple.version !== '1.0.0') fail('REVIEW_CONFLICT');
  const review = metadata.apple.review;
  if (review && (typeof review !== 'object' || Array.isArray(review))) fail('REVIEW_CONFLICT');
  if (review?.demoUsername && review.demoUsername !== journal?.email) fail('REVIEW_CONFLICT');
  if (review?.demoPassword && review.demoPassword !== journal?.password) fail('REVIEW_CONFLICT');
}

export async function prepareReviewAccount({ root = process.cwd(), credentialsPath,
  selectCredentials = pickReviewCredentialsFile, adminFactory = firebaseAdmin,
  request = requestJson, download = downloadTemplate, log = console.log } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('REVIEW_PROJECT');
  root = await realpath(resolve(root));
  let env, app, pkg;
  try {
    for (const path of ['package.json', 'app.json', '.env', 'server/package.json', '.gitignore', '.easignore']) await checkedPath(root, path);
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
    env = parseEnv(utf8(await readFile(join(root, '.env'))));
  } catch { fail('REVIEW_PROJECT'); }
  if (pkg.name !== 'tamaya-members-demo' || app?.owner !== 'oneight' || app?.extra?.eas?.projectId !== REVIEW_EAS_PROJECT_ID
    || app?.ios?.bundleIdentifier !== 'jp.oneeight.tamaya.members' || env.EXPO_PUBLIC_FIREBASE_PROJECT_ID !== REVIEW_PROJECT_ID
    || env.EXPO_PUBLIC_API_URL !== API || env.EXPO_PUBLIC_STORE_ID !== 'tamaya' || env.EXPO_PUBLIC_APP_MODE !== 'production'
    || !/^[A-Za-z0-9_-]{20,100}$/.test(env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '')
    || env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL || process.env.FIREBASE_AUTH_EMULATOR_HOST
    || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('REVIEW_PROJECT');
  await requirePrivateIgnores(root, [REVIEW_JOURNAL, REVIEW_METADATA, `.env.review-update-${randomUUID()}.tmp`]);
  let journal = await privateJson(root, REVIEW_JOURNAL);
  if (journal) validateJournal(journal);
  let metadata = await privateJson(root, REVIEW_METADATA);
  if (metadata) validateMetadata(metadata, journal);
  const selected = credentialsPath ?? await selectCredentials();
  if (typeof selected !== 'string' || (!isAbsolute(selected) && !win32.isAbsolute(selected)) || !/\.json$/i.test(selected) || /[\x00-\x1f\x7f]/.test(selected)) fail('REVIEW_CREDENTIALS');
  let account;
  try { account = JSON.parse(utf8(await readFile(selected))); } catch { fail('REVIEW_CREDENTIALS'); }
  if (account?.type !== 'service_account' || typeof account.project_id !== 'string' || typeof account.client_email !== 'string'
    || !account.client_email.endsWith('.gserviceaccount.com') || typeof account.private_key !== 'string'
    || !account.private_key.includes('-----BEGIN PRIVATE KEY-----')) fail('REVIEW_CREDENTIALS');
  if (account.project_id !== REVIEW_PROJECT_ID) fail('REVIEW_CREDENTIALS_PROJECT');
  metadata ??= await metadataTemplate(download);
  validateMetadata(metadata, journal);
  log('公開設定と、審査用アカウントの準備先を確認しています。');
  let publicStore;
  try { publicStore = await request({ url: `${API}/v1/stores/tamaya` }); } catch { fail('REVIEW_BACKEND'); }
  if (publicStore.id !== 'tamaya' || publicStore.legal?.termsVersion !== VERSION || publicStore.legal?.privacyVersion !== VERSION) fail('REVIEW_BACKEND');
  if (!journal) {
    const id = randomUUID();
    journal = { version: 1, projectId: REVIEW_PROJECT_ID, storeId: 'tamaya', uid: `app-review-${id}`,
      email: `app-review-${id.replaceAll('-', '').slice(0, 12)}@tamaya-review.invalid`,
      password: `Aa9!${randomBytes(24).toString('base64url')}`, markerNonce: randomUUID(), registrationKey: randomUUID(), phase: 'intent' };
    await savePrivate(root, REVIEW_JOURNAL, journal, true);
  }
  const savePhase = async phase => {
    if (phases.indexOf(journal.phase) < phases.indexOf(phase)) {
      journal = { ...journal, phase };
      await savePrivate(root, REVIEW_JOURNAL, journal);
    }
  };
  const signIn = async () => {
    let token;
    try {
      token = await request({ url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(env.EXPO_PUBLIC_FIREBASE_API_KEY)}`,
        method: 'POST', body: { email: journal.email, password: journal.password, returnSecureToken: true } });
    } catch { fail('REVIEW_LOGIN'); }
    if (token.localId !== journal.uid || typeof token.idToken !== 'string' || !token.idToken || token.idToken.length > 20000) fail('REVIEW_LOGIN');
    return token.idToken;
  };
  let admin;
  try {
    admin = await adminFactory({ root, account });
    const auth = admin.auth;
    let user, justCreated = false;
    try { user = await auth.getUser(journal.uid); }
    catch (error) {
      if (error.code !== 'auth/user-not-found') fail('REVIEW_AUTH');
      if (journal.phase !== 'intent') fail('REVIEW_ACCOUNT_MISSING');
      try { user = await auth.createUser({ uid: journal.uid, email: journal.email, password: journal.password, emailVerified: true, disabled: false }); }
      catch { fail('REVIEW_AUTH'); }
      justCreated = true;
      await savePhase('created');
    }
    if (user.uid !== journal.uid || user.email !== journal.email || user.disabled || !user.emailVerified) fail('REVIEW_ACCOUNT_CONFLICT');
    const marker = user.customClaims?.tamayaAppReview;
    const expectedMarker = { version: 1, storeId: 'tamaya', nonce: journal.markerNonce };
    if (!marker) {
      if (journal.phase === 'registered' || Object.keys(user.customClaims ?? {}).length) fail('REVIEW_ACCOUNT_CONFLICT');
      // An uncertain create response can be recovered only by proving the locally saved password.
      if (!justCreated) await signIn();
      try { await auth.setCustomUserClaims(journal.uid, { tamayaAppReview: expectedMarker }); } catch { fail('REVIEW_AUTH'); }
    } else if (marker.version !== 1 || marker.storeId !== 'tamaya' || marker.nonce !== journal.markerNonce
      || Object.keys(user.customClaims).some(key => key !== 'tamayaAppReview')
      || Object.keys(marker).some(key => !['version', 'storeId', 'nonce'].includes(key))) fail('REVIEW_ACCOUNT_CONFLICT');
    await savePhase('created');
    const idToken = await signIn();
    const headers = { Authorization: `Bearer ${idToken}` };
    let before, member, after;
    try { before = await request({ url: `${API}/v1/stores/tamaya/me`, headers }); } catch { fail('REVIEW_REGISTER'); }
    if (before.staff !== null) fail('REVIEW_ROLE');
    log('審査用の一般会員を、通常の登録処理で確認しています。');
    try {
      member = await request({ url: `${API}/v1/stores/tamaya/me/register`, method: 'POST',
        headers: { ...headers, 'Idempotency-Key': journal.registrationKey },
        body: { nickname: 'たまやの確認会員', acceptedTermsVersion: VERSION, acceptedPrivacyVersion: VERSION } });
      after = await request({ url: `${API}/v1/stores/tamaya/me`, headers });
    } catch { fail('REVIEW_REGISTER'); }
    if (typeof member?.id !== 'string' || !member.id || after.staff !== null || after.member?.id !== member.id
      || (!before.member && (member.stamps !== 0 || !Array.isArray(member.coupons) || member.coupons.length))) fail('REVIEW_ROLE');
    await savePhase('registered');
    // Read again so private contact fields added during network requests are not discarded.
    const latestMetadata = await privateJson(root, REVIEW_METADATA) ?? metadata;
    validateMetadata(latestMetadata, journal);
    latestMetadata.apple.review = { ...latestMetadata.apple.review,
      demoUsername: journal.email, demoPassword: journal.password, demoRequired: true };
    const notes = latestMetadata.apple.review.notes;
    if (notes !== undefined && typeof notes !== 'string') fail('REVIEW_CONFLICT');
    if (!notes?.includes(REVIEW_ACCESS_NOTE)) {
      latestMetadata.apple.review.notes = [notes?.trim(), REVIEW_ACCESS_NOTE].filter(Boolean).join('\n\n');
    }
    await savePrivate(root, REVIEW_METADATA, latestMetadata);
    log('審査用の一般会員と、PC内の審査用ログイン設定を準備しました。');
    log('スタッフ権限・スタンプ残高・特典の追加や変更は行っていません。');
    return { phase: journal.phase };
  } catch (error) { if (error instanceof ReviewAccountError) throw error; fail('REVIEW_AUTH'); }
  finally { if (admin?.close) await Promise.resolve().then(() => admin.close()).catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/prepare-review-account.mjs [--pick-credentials | --credentials "PC内の管理用JSONのパス"]\n審査用の一般会員とPC内の非公開ログイン設定を準備します。管理用JSONの内容を共有する必要はありません。');
  } else {
    let credentialsPath;
    try {
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--pick-credentials') continue;
        if (args[index] !== '--credentials' || credentialsPath !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail('REVIEW_CREDENTIALS');
        credentialsPath = args[++index];
      }
      await prepareReviewAccount({ credentialsPath });
    } catch (error) {
      console.error(error instanceof ReviewAccountError ? error.message : '[REVIEW_FAILED] 準備を完了できませんでした。画面を担当者へ伝えてください。');
      process.exitCode = 1;
    }
  }
}
