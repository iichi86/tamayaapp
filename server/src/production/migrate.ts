import { Pool } from 'pg';
import { loadProductionEnvironment, productionConfig, ProductionConfigurationError } from './config.js';
import { PostgresDatabase } from './database.js';

async function main() {
  loadProductionEnvironment();
  // Runtime credentials and migration credentials may be separated. The latter never go into the app.
  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL };
  const config = productionConfig(env);
  const db = new PostgresDatabase(new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10_000 }));
  try { await db.migrate(); console.log('PostgreSQLの会員サービス用テーブルを準備しました。'); }
  finally { await db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof ProductionConfigurationError ? error.message : 'DBの準備を完了できませんでした。接続先・管理者権限を確認してください。'); process.exitCode = 1; });
