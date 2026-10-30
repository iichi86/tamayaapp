import { Pool } from 'pg';
import { databaseSetupConfig, loadProductionEnvironment, ProductionConfigurationError } from './config.js';
import { PostgresDatabase } from './database.js';
import { resolveDatabasePasswordPlaceholder } from './passwordPrompt.js';

async function main() {
  loadProductionEnvironment();
  const config = databaseSetupConfig(await resolveDatabasePasswordPlaceholder());
  const db = new PostgresDatabase(new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10_000 }));
  try { await db.migrate(); console.log('PostgreSQLの会員サービス用テーブルを準備しました。'); }
  finally { await db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof ProductionConfigurationError ? error.message : 'DBの準備を完了できませんでした。接続先・管理者権限を確認してください。'); process.exitCode = 1; });
