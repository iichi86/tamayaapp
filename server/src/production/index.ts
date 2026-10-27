import { Pool } from 'pg';
import { createProductionApp, processDeletionJobs } from './app.js';
import { createFirebaseIdentityProvider } from './auth.js';
import { loadProductionEnvironment, loadStoreConfiguration, productionConfig, ProductionConfigurationError } from './config.js';
import { PostgresDatabase } from './database.js';

async function main(): Promise<void> {
  loadProductionEnvironment();
  const config = productionConfig();
  const store = loadStoreConfiguration(config);
  const pool = new Pool({
    connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 10,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    statement_timeout: 15_000, query_timeout: 20_000, application_name: 'tamaya-management-api',
  });
  const db = new PostgresDatabase(pool);
  let app: Awaited<ReturnType<typeof createProductionApp>> | undefined;
  let worker: ReturnType<typeof setInterval> | undefined;
  try {
    await db.upsertStore(store, config.projectId);
    const verifier = createFirebaseIdentityProvider({ projectId: config.projectId, mode: config.authMode, emulatorHost: config.emulatorHost });
    app = await createProductionApp({
      db, verifier, projectId: config.projectId, storeId: store.id, qrSecret: config.qrSecret,
      allowedOrigins: config.allowedOrigins, localOnly: config.environment === 'local',
      authMode: config.authMode, logger: true, trustProxyHops: config.trustProxyHops,
    });
    let processing = false;
    const runDeletions = async () => {
      if (processing) return;
      processing = true;
      try {
        const result = await processDeletionJobs(db, verifier, config.projectId);
        if (result.failed) app!.log.warn({ event: 'account_deletion_retry', count: result.failed }, '未完了の退会処理を次回再試行します。');
      } catch { app!.log.warn({ event: 'account_deletion_worker_failed' }, '退会処理の再試行を次回実行します。'); }
      finally { processing = false; }
    };
    await runDeletions();
    worker = setInterval(() => { void runDeletions(); }, 30_000);
    worker.unref();
    const address = await app.listen({ host: config.host, port: config.port });
    console.log(`玉屋 会員サービスAPI: ${address}`);
    console.log(config.authMode === 'emulator' ? 'ローカル検証用です。認証・会員データは本番に引き継ぎません。' : 'Firebase認証・共有PostgreSQLを使用しています。');
    if (!store.reward.operationsEnabled) console.log('正式な特典内容が未確定のため、スタンプ・特典の運用は停止しています。');
    console.log('終了: Ctrl + C');
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      if (worker) clearInterval(worker);
      await app!.close();
      await db.close();
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) {
    if (worker) clearInterval(worker);
    if (app) await app.close();
    await db.close();
    throw error;
  }
}
main().catch((error: unknown) => {
  // Credentials and connection strings can be contained in upstream SDK error messages.
  console.error(error instanceof ProductionConfigurationError ? error.message : '管理サーバーを起動できませんでした。環境変数、DBマイグレーション、認証設定を確認してください。秘密値はログへ出力していません。');
  process.exitCode = 1;
});
