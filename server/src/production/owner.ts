import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { getAuth } from 'firebase-admin/auth';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { databaseSetupConfig, loadProductionEnvironment } from './config.js';
import { PostgresDatabase } from './database.js';
import { resolveDatabasePasswordPlaceholder } from './passwordPrompt.js';
import { formatDatabaseSetupError } from './setupErrors.js';

const messages = {
  OWNER_UID_REQUIRED: '--uidの後ろに、メール確認を済ませた本人のFirebase UIDを指定してください。',
  OWNER_CONFIGURATION: '本番用のFirebaseプロジェクトIDとAUTH_MODE=firebaseを確認してください。認証エミュレーターでは実店舗のオーナーを設定できません。',
  OWNER_DATABASE_ADMIN_REQUIRED: '初期準備用のDATABASE_MIGRATION_URLを設定してください。常設APIの接続設定は変更しません。',
  OWNER_CREDENTIALS_REQUIRED: 'PCに保存したFirebase管理用JSONの場所を--credentialsまたはGOOGLE_APPLICATION_CREDENTIALSで指定してください。内容を共有する必要はありません。',
  OWNER_CREDENTIALS_INVALID: 'Firebase管理用JSONを読み取れないか、形式が正しくありません。PCに保存した管理用ファイルの場所を確認してください。',
  OWNER_CREDENTIALS_PROJECT: 'Firebase管理用JSONのプロジェクトとFIREBASE_PROJECT_IDが一致しません。正しい店舗のプロジェクトを確認してください。',
  OWNER_FILE_SELECTION_CANCELLED: '管理用JSONが選択されなかったため、権限を変更せずに終了しました。準備できたら同じコマンドを実行してください。',
  OWNER_FILE_PICKER_UNAVAILABLE: 'Windowsのファイル選択画面を開けませんでした。--credentialsで管理用JSONのパスを指定する方法を使ってください。',
  OWNER_ACCOUNT_NOT_FOUND: '指定されたUIDのFirebaseアカウントが見つかりません。本人のアカウントのUIDを確認してください。',
  OWNER_AUTH_FAILED: 'Firebaseのアカウントを確認できませんでした。管理用JSON、Firebaseの設定、PCの接続を確認してください。',
  OWNER_ACCOUNT_NOT_VERIFIED: 'このアカウントはメール確認が完了していません。確認メールのリンクを開いてから再実行してください。',
  OWNER_ACCOUNT_DISABLED: 'このアカウントは停止されています。利用できる本人のアカウントを確認してください。',
  OWNER_STORE_CONFIGURATION: '店舗設定ファイルを読み取れないか、店舗IDが正しくありません。STORE_CONFIG_PATHと店舗設定を確認してください。',
  OWNER_STORE_NOT_READY: '共有DBに対象の店舗が見つかりません。管理APIの初回起動と接続先を確認してください。',
  OWNER_STORE_PROJECT: '共有DBの店舗とFirebaseプロジェクトが一致しません。権限は変更していません。接続先を確認してください。',
  OWNER_CLEANUP_FAILED: '接続の終了処理を完了できませんでした。このコードを開発担当へ伝えてください。',
} as const;

export class OwnerSetupError extends Error {
  constructor(readonly diagnosticCode: keyof typeof messages) {
    super(`[${diagnosticCode}] ${messages[diagnosticCode]}`);
    this.name = 'OwnerSetupError';
  }
}

export interface OwnerSetupOptions {
  uid: string;
  credentialsPath?: string;
  env?: NodeJS.ProcessEnv;
  readPassword?: () => Promise<string>;
}

/** Desktop-only convenience. The selected path stays in this local process. */
export function pickOwnerCredentialsFile(options: { platform?: NodeJS.Platform; select?: () => string } = {}): string {
  if ((options.platform ?? process.platform) !== 'win32') throw new OwnerSetupError('OWNER_FILE_PICKER_UNAVAILABLE');
  let selected: string;
  try {
    selected = options.select ? options.select() : execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = 'Firebase管理用JSONを選んでください'",
      "$dialog.Filter = 'Firebase管理用JSON (*.json)|*.json'",
      '$dialog.CheckFileExists = $true',
      '$dialog.Multiselect = $false',
      "$dialog.InitialDirectory = [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), 'Downloads')",
      'try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) } else { exit 3 } } finally { $dialog.Dispose() }',
    ].join('; ')], { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 });
  } catch (error) {
    throw new OwnerSetupError((error as { status?: number })?.status === 3 ? 'OWNER_FILE_SELECTION_CANCELLED' : 'OWNER_FILE_PICKER_UNAVAILABLE');
  }
  selected = selected.trim();
  if (!selected) throw new OwnerSetupError('OWNER_FILE_SELECTION_CANCELLED');
  if (!win32.isAbsolute(selected) || !/\.json$/i.test(selected) || /[\x00-\x1f\x7f]/.test(selected)) throw new OwnerSetupError('OWNER_CREDENTIALS_INVALID');
  return selected;
}

export function parseOwnerArguments(args: string[]): { uid: string; credentialsPath?: string; pickCredentials: boolean } {
  let uid: string | undefined;
  let credentialsPath: string | undefined;
  let pickCredentials = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--pick-credentials' && !pickCredentials) { pickCredentials = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new OwnerSetupError('OWNER_UID_REQUIRED');
    if (flag === '--uid' && uid === undefined) uid = value;
    else if (flag === '--credentials' && credentialsPath === undefined) credentialsPath = value;
    else throw new OwnerSetupError('OWNER_UID_REQUIRED');
  }
  if (!uid) throw new OwnerSetupError('OWNER_UID_REQUIRED');
  if (pickCredentials && credentialsPath) throw new OwnerSetupError('OWNER_CREDENTIALS_INVALID');
  return { uid, credentialsPath, pickCredentials };
}

/** Trusted local setup only. Never expose this operation through an HTTP route. */
export async function bootstrapProductionOwner(options: OwnerSetupOptions): Promise<void> {
  const env = options.env ?? process.env;
  const uid = options.uid;
  if (!uid || uid.length > 128 || /[\s\x00-\x1f\x7f]/.test(uid)) throw new OwnerSetupError('OWNER_UID_REQUIRED');
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if ((env.APP_ENV ?? 'production') !== 'production' || (env.AUTH_MODE ?? 'firebase') !== 'firebase'
    || env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST
    || !projectId || !/^[a-z0-9][a-z0-9-]{3,62}$/.test(projectId) || projectId.startsWith('demo-')) {
    throw new OwnerSetupError('OWNER_CONFIGURATION');
  }
  if (!env.DATABASE_MIGRATION_URL?.trim()) throw new OwnerSetupError('OWNER_DATABASE_ADMIN_REQUIRED');

  const credentialsPath = options.credentialsPath?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!credentialsPath) throw new OwnerSetupError('OWNER_CREDENTIALS_REQUIRED');
  let account: { project_id?: unknown; type?: unknown; client_email?: unknown; private_key?: unknown };
  try { account = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch { throw new OwnerSetupError('OWNER_CREDENTIALS_INVALID'); }
  if (!account || account.type !== 'service_account' || typeof account.project_id !== 'string'
    || typeof account.client_email !== 'string' || !account.client_email.endsWith('.gserviceaccount.com')
    || typeof account.private_key !== 'string' || !account.private_key.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new OwnerSetupError('OWNER_CREDENTIALS_INVALID');
  }
  if (account.project_id !== projectId) throw new OwnerSetupError('OWNER_CREDENTIALS_PROJECT');
  let storeId: string;
  try {
    const store = JSON.parse(await readFile(resolve(env.STORE_CONFIG_PATH ?? 'config/tamaya.json'), 'utf8')) as { id?: unknown };
    if (!store || typeof store.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(store.id)) throw new Error('Invalid store');
    storeId = store.id;
  } catch { throw new OwnerSetupError('OWNER_STORE_CONFIGURATION'); }

  let app: App | undefined;
  let pool: Pool | undefined;
  let db: PostgresDatabase | undefined;
  try {
    try {
      app = initializeApp({ projectId, credential: cert({ projectId, clientEmail: account.client_email, privateKey: account.private_key }) }, `tamaya-owner-cli:${projectId}:${randomUUID()}`);
    } catch { throw new OwnerSetupError('OWNER_CREDENTIALS_INVALID'); }
    let user;
    try { user = await getAuth(app).getUser(uid); }
    catch (error) {
      let code: unknown;
      try { code = (error as { code?: unknown })?.code; } catch { /* Only classify; never display upstream text. */ }
      throw new OwnerSetupError(code === 'auth/user-not-found' ? 'OWNER_ACCOUNT_NOT_FOUND' : 'OWNER_AUTH_FAILED');
    }
    if (user.uid !== uid) throw new OwnerSetupError('OWNER_AUTH_FAILED');
    if (user.disabled) throw new OwnerSetupError('OWNER_ACCOUNT_DISABLED');
    if (!user.emailVerified) throw new OwnerSetupError('OWNER_ACCOUNT_NOT_VERIFIED');

    // Ask for the DB password only after the local files and Firebase account are ready.
    const config = databaseSetupConfig(await resolveDatabasePasswordPlaceholder(env, options.readPassword));
    pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10_000 });
    db = new PostgresDatabase(pool);
    const existing = await pool.query<{ firebase_project_id: string }>('SELECT firebase_project_id FROM tamaya.stores WHERE id=$1', [storeId]);
    if (!existing.rows[0]) throw new OwnerSetupError('OWNER_STORE_NOT_READY');
    if (existing.rows[0].firebase_project_id !== projectId) throw new OwnerSetupError('OWNER_STORE_PROJECT');
    // The running API owns store configuration. Do not replace its URLs or policy from this PC.
    await db.bootstrapOwner(storeId, uid);
  } finally {
    let cleanupFailed = false;
    if (db) await db.close().catch(() => { cleanupFailed = true; });
    else if (pool) await pool.end().catch(() => { cleanupFailed = true; });
    if (app) await deleteApp(app).catch(() => { cleanupFailed = true; });
    if (cleanupFailed) console.error(new OwnerSetupError('OWNER_CLEANUP_FAILED').message);
  }
}

async function main(): Promise<void> {
  loadProductionEnvironment();
  const { uid, credentialsPath, pickCredentials } = parseOwnerArguments(process.argv.slice(2));
  if (pickCredentials) console.log('Windowsのファイル選択画面で、Firebase管理用JSONを選んでください。');
  await bootstrapProductionOwner({ uid, credentialsPath: pickCredentials ? pickOwnerCredentialsFile() : credentialsPath });
  console.log('オーナー権限を設定しました。アプリで再読み込みすると店舗管理が利用できます。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof OwnerSetupError ? error.message : formatDatabaseSetupError(error));
    process.exitCode = 1;
  });
}
