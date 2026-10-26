import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { createDemoVerifier, createFirebaseVerifier } from './auth.js';
import { ServerDatabase } from './database.js';
import { ensureConfiguredStore, loadEnvironment, runtimeConfig } from './config.js';

async function main() {
  loadEnvironment();
  const config = runtimeConfig();
  const db = new ServerDatabase(config.databasePath);
  try {
    if (config.demoMode) db.seedDemo(); else ensureConfiguredStore(db);
    const app = await createApp({
      db, qrSecret: config.qrSecret, demoMode: config.demoMode,
      verifier: config.demoMode ? createDemoVerifier() : createFirebaseVerifier(),
      demoHtml: config.demoMode ? readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8') : undefined,
      allowedOrigins: config.allowedOrigins,
    });
    const address = await app.listen({ host: config.host, port: config.port });
    console.log(`玉屋 管理サーバー: ${address}`);
    console.log(config.demoMode ? '開発用・架空データです。この画面で役割を切り替えて試せます。' : 'Firebase認証モードです。既存iPhoneアプリとの接続は別途必要です。');
    console.log('終了: Ctrl + C');
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; await app.close(); db.close(); };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { db.close(); throw error; }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '管理サーバーを起動できませんでした。');
  process.exitCode = 1;
});
