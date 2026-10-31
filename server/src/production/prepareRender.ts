import { randomBytes, X509Certificate } from 'node:crypto';
import { open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const messages = {
  RENDER_RUNTIME_MISSING: '実行専用DBの設定を読み取れませんでした。専用ユーザーの作成が完了し、現在のserverフォルダーに.env.runtime.generatedがあることを確認してください。',
  RENDER_RUNTIME_INVALID: '実行専用DBの設定を確認してください。所有者用の接続情報や未設定の値は取り込めません。ファイルの中身を共有せず、開発担当へこのコードを伝えてください。',
  RENDER_CA_MISSING: 'supabase-ca.crtを読み取れませんでした。公式の証明書を現在のserverフォルダーへ保存してください。',
  RENDER_CA_INVALID: 'supabase-ca.crtが有効なCA証明書ではないか、有効期間外です。PCの日時と、公式の証明書ファイルを確認してください。',
  RENDER_PROJECT_INVALID: 'FirebaseのプロジェクトIDを確認してください。',
  RENDER_OUTPUT_EXISTS: '.env.render.generatedはすでに存在します。既存の設定は上書きしていません。そのファイルを保管したまま使ってください。',
  RENDER_OUTPUT_FAILED: 'Render取り込み用の設定を保存できませんでした。現在のserverフォルダーの書き込み権限と空き容量を確認してください。',
  RENDER_PREPARE_FAILED: 'Render取り込み用の設定を作成できませんでした。秘密値を共有せず、開発担当へこのコードを伝えてください。',
} as const;

export class RenderPreparationError extends Error {
  constructor(readonly diagnosticCode: keyof typeof messages) {
    super(`[${diagnosticCode}] ${messages[diagnosticCode]}`);
    this.name = 'RenderPreparationError';
  }
}

/** Local preparation only: never contacts Render, Firebase or the database. */
export async function prepareRenderEnvironment(options: { directory?: string; projectId?: string; now?: Date } = {}): Promise<string> {
  const directory = resolve(options.directory ?? '.');
  const projectId = options.projectId ?? 'tamayaapp';
  if (!/^[a-z0-9][a-z0-9-]{3,62}$/.test(projectId)) throw new RenderPreparationError('RENDER_PROJECT_INVALID');
  let runtimeText: string;
  try { runtimeText = await readFile(resolve(directory, '.env.runtime.generated'), 'utf8'); }
  catch { throw new RenderPreparationError('RENDER_RUNTIME_MISSING'); }
  let databaseUrl: string;
  try {
    const parsedUrl = parseEnv(runtimeText).DATABASE_URL;
    if (!parsedUrl) throw new Error('Missing runtime configuration');
    databaseUrl = parsedUrl;
    const database = new URL(databaseUrl);
    if (!['postgresql:', 'postgres:'].includes(database.protocol)
      || !/^tamaya_runtime(?:\.[a-z0-9-]+)?$/.test(decodeURIComponent(database.username))
      || !/^[a-f0-9]{72}$/.test(decodeURIComponent(database.password))
      || !/^(?:[a-z0-9-]+\.)+(?:supabase\.co|pooler\.supabase\.com)$/.test(database.hostname)
      || !database.pathname.slice(1) || database.hash
      || [...database.searchParams.keys()].some((key) => ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'].includes(key))) {
      throw new Error('Invalid runtime configuration');
    }
  } catch { throw new RenderPreparationError('RENDER_RUNTIME_INVALID'); }

  let certificateBytes: Buffer;
  try { certificateBytes = await readFile(resolve(directory, 'supabase-ca.crt')); }
  catch { throw new RenderPreparationError('RENDER_CA_MISSING'); }
  try {
    const certificate = new X509Certificate(certificateBytes);
    const now = (options.now ?? new Date()).getTime();
    if (!certificate.ca || !Number.isFinite(now) || now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) throw new Error('Invalid certificate');
  } catch { throw new RenderPreparationError('RENDER_CA_INVALID'); }

  const outputPath = resolve(directory, '.env.render.generated');
  const values: Record<string, string> = {
    APP_ENV: 'production', AUTH_MODE: 'firebase', HOST: '0.0.0.0', TRUST_PROXY_HOPS: '1',
    FIREBASE_PROJECT_ID: projectId, DATABASE_URL: databaseUrl,
    QR_SIGNING_SECRET: randomBytes(32).toString('hex'),
    GOOGLE_APPLICATION_CREDENTIALS: '/etc/secrets/firebase-admin.json',
    DATABASE_CA_PATH: '/etc/secrets/supabase-ca.crt',
  };
  const contents = '# Server-only Render import. Keep private; never share or put in Expo.\n'
    + Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  let file: FileHandle;
  try { file = await open(outputPath, 'wx', 0o600); }
  catch (error) {
    throw new RenderPreparationError((error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'RENDER_OUTPUT_EXISTS' : 'RENDER_OUTPUT_FAILED');
  }
  try {
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
  } catch {
    await file.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw new RenderPreparationError('RENDER_OUTPUT_FAILED');
  }
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareRenderEnvironment().then(() => {
    console.log('Render取り込み用の設定を.env.render.generatedに保存しました。');
    console.log('このファイルの中身はRenderの非公開設定だけに登録し、チャットやGitHubへ貼り付けないでください。');
  }).catch((error: unknown) => {
    console.error(error instanceof RenderPreparationError ? error.message : new RenderPreparationError('RENDER_PREPARE_FAILED').message);
    process.exitCode = 1;
  });
}
