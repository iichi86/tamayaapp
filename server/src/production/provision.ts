import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { loadProductionEnvironment, productionConfig } from './config.js';

/** One-time, owner-run provisioning. Never expose this as an HTTP endpoint. */
async function main(): Promise<void> {
  loadProductionEnvironment();
  const config = productionConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL });
  const role = 'tamaya_runtime';
  const filePath = resolve('.env.runtime.generated');
  const file = await open(filePath, 'wx', 0o600);
  let succeeded = false;
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10000 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const password = randomBytes(36).toString('hex');
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (existing.rowCount) throw new Error('Runtime role already exists');
    // role/password are fixed or hex generated here, never request input or logged.
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`GRANT tamaya_api TO ${role}`);
    const runtime = new URL(config.databaseUrl);
    const currentUser = decodeURIComponent(runtime.username);
    // Supabase shared pooler uses <database-role>.<project-ref> as its username.
    runtime.username = runtime.hostname.includes('pooler.supabase.com') && currentUser.includes('.')
      ? `${role}.${currentUser.slice(currentUser.indexOf('.') + 1)}` : role;
    runtime.password = password;
    await file.writeFile(`# Server-only generated credential. Keep private; never copy into Expo.\nDATABASE_URL=${JSON.stringify(runtime.toString())}\n`, 'utf8');
    await client.query('COMMIT');
    succeeded = true;
    console.log('実行専用DBユーザーを作成しました。接続情報はserver/.env.runtime.generatedに保存しました。');
    console.log('このファイルのDATABASE_URLをサーバーの秘密設定へ移し、DATABASE_MIGRATION_URLは常設サーバーへ設定しないでください。');
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('実行用ユーザーを作成できませんでした。移行の完了、管理権限、既存tamaya_runtimeロールを確認してください。秘密値は表示していません。');
  } finally {
    await file.close(); client?.release(); await pool.end();
    if (!succeeded) await unlink(filePath).catch(() => undefined);
  }
}
main().catch(() => { console.error('DB実行用設定を生成できませんでした。既存ファイルを上書きしません。接続設定・権限を確認してください。'); process.exitCode = 1; });
