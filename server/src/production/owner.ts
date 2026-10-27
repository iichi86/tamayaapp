import { Pool } from 'pg';
import { getAuth } from 'firebase-admin/auth';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { loadProductionEnvironment, loadStoreConfiguration, productionConfig, ProductionConfigurationError } from './config.js';
import { PostgresDatabase } from './database.js';

async function main() {
  loadProductionEnvironment();
  const config = productionConfig();
  const store = loadStoreConfiguration(config);
  const index = process.argv.indexOf('--uid');
  const uid = index >= 0 ? process.argv[index + 1] : undefined;
  if (!uid || uid.length > 128 || /[\s\x00-\x1f]/.test(uid)) throw new Error('INVALID_UID');
  if (config.authMode === 'emulator') process.env.FIREBASE_AUTH_EMULATOR_HOST = config.emulatorHost;
  const name = `tamaya-owner-cli:${config.projectId}`;
  const app = getApps().find((candidate) => candidate.name === name) ?? initializeApp({
    projectId: config.projectId, ...(config.authMode === 'firebase' ? { credential: applicationDefault() } : {}),
  }, name);
  const user = await getAuth(app).getUser(uid);
  if (!user.emailVerified || user.disabled) throw new Error('OWNER_ACCOUNT_NOT_VERIFIED');
  const db = new PostgresDatabase(new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1, connectionTimeoutMillis: 10_000 }));
  try {
    await db.upsertStore(store, config.projectId);
    await db.bootstrapOwner(store.id, uid);
    console.log(`${store.name}のオーナー権限を設定しました。次回ログイン時に店舗管理が利用できます。`);
  } finally { await db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof ProductionConfigurationError ? error.message : 'オーナーを設定できませんでした。--uid、確認済みのFirebase会員、DBの管理権限を確認してください。'); process.exitCode = 1; });
