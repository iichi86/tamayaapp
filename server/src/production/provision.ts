import { randomBytes } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { databaseSetupConfig, loadProductionEnvironment } from './config.js';
import { resolveDatabasePasswordPlaceholder } from './passwordPrompt.js';
import { DatabaseSetupError, formatDatabaseSetupError } from './setupErrors.js';

/** One-time, owner-run provisioning. Never expose this as an HTTP endpoint. */
export async function provisionRuntime(config: ReturnType<typeof databaseSetupConfig>, filePath = resolve('.env.runtime.generated')): Promise<void> {
  const role = 'tamaya_runtime';
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10000 });
  let file: FileHandle | undefined;
  let client: PoolClient | undefined;
  let fileClosed = false;
  let committed = false;
  let commitSent = false;
  let failed = false;
  let failure: unknown;
  let cleanupFailed = false;
  try {
    try { file = await open(filePath, 'wx', 0o600); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      throw new DatabaseSetupError(code === 'EEXIST' ? 'DB_OUTPUT_EXISTS'
        : code === 'EACCES' || code === 'EPERM' ? 'DB_OUTPUT_PERMISSION' : 'DB_OUTPUT_WRITE_FAILED', { cause: error });
    }
    client = await pool.connect();
    const password = randomBytes(36).toString('hex');
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (existing.rowCount) throw new DatabaseSetupError('DB_RUNTIME_ROLE_EXISTS');
    // role/password are fixed or hex generated here, never request input or logged.
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`GRANT tamaya_api TO ${role}`);
    const runtime = new URL(config.databaseUrl);
    const currentUser = decodeURIComponent(runtime.username);
    // Supabase shared pooler uses <database-role>.<project-ref> as its username.
    runtime.username = runtime.hostname.includes('pooler.supabase.com') && currentUser.includes('.')
      ? `${role}.${currentUser.slice(currentUser.indexOf('.') + 1)}` : role;
    runtime.password = password;
    try {
      await file.writeFile(`# Server-only generated credential. Keep private; never copy into Expo.\nDATABASE_URL=${JSON.stringify(runtime.toString())}\n`, 'utf8');
      await file.sync();
      await file.close();
      fileClosed = true;
    } catch (error) { throw new DatabaseSetupError('DB_OUTPUT_WRITE_FAILED', { cause: error }); }
    // Once COMMIT is sent, a lost response cannot prove whether the role was created.
    // Retain the durable credential instead of leaving a possibly committed role inaccessible.
    commitSent = true;
    try { await client.query('COMMIT'); committed = true; }
    catch (error) { throw new DatabaseSetupError('DB_COMMIT_UNCERTAIN', { cause: error }); }
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    failure = error;
    failed = true;
  } finally {
    if (file && !fileClosed) await file.close().catch(() => { cleanupFailed = true; });
    try { client?.release(); } catch { cleanupFailed = true; }
    await pool.end().catch(() => { cleanupFailed = true; });
    // Only remove a file opened by this run, and only before COMMIT could have succeeded.
    if (file && !committed && !commitSent) await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') cleanupFailed = true;
    });
  }
  if (cleanupFailed) console.error(formatDatabaseSetupError(new DatabaseSetupError('DB_CLEANUP_FAILED')));
  if (failed) throw failure;
}

async function main(): Promise<void> {
  loadProductionEnvironment();
  const config = databaseSetupConfig(await resolveDatabasePasswordPlaceholder());
  await provisionRuntime(config);
  console.log('実行専用DBユーザーを作成しました。接続情報はserver/.env.runtime.generatedに保存しました。');
  console.log('このファイルのDATABASE_URLをサーバーの秘密設定へ移し、DATABASE_MIGRATION_URLは常設サーバーへ設定しないでください。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(formatDatabaseSetupError(error)); process.exitCode = 1; });
}
