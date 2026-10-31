import { Pool } from 'pg';
import { databaseSetupConfig, loadProductionEnvironment } from './config.js';
import { PostgresDatabase } from './database.js';
import { resolveDatabasePasswordPlaceholder } from './passwordPrompt.js';
import { formatDatabaseSetupError } from './setupErrors.js';

async function main() {
  loadProductionEnvironment();
  const config = databaseSetupConfig(await resolveDatabasePasswordPlaceholder());
  const db = new PostgresDatabase(new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10_000 }));
  try { await db.migrate(); console.log('PostgreSQLの会員サービス用テーブルを準備しました。'); }
  finally { await db.close(); }
}
main().catch((error: unknown) => { console.error(formatDatabaseSetupError(error)); process.exitCode = 1; });
