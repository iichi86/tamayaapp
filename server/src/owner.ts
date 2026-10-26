import { resolve } from 'node:path';
import { ServerDatabase } from './database.js';
import { ensureConfiguredStore, loadEnvironment } from './config.js';

loadEnvironment();
const index = process.argv.indexOf('--uid');
const uid = index >= 0 ? process.argv[index + 1] : undefined;
if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
  console.error('使い方: npm run owner -- --uid "Firebase Authenticationで確認した管理者のUID"');
  process.exitCode = 1;
} else {
  const db = new ServerDatabase(resolve(process.env.DATABASE_PATH ?? 'data/tamaya.sqlite'));
  try {
    const store = ensureConfiguredStore(db);
    db.bootstrapOwner(store.id, uid);
    console.log(`${store.name}の管理者権限を設定しました。対象UIDと店舗を確認してください。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '管理者を設定できませんでした。');
    process.exitCode = 1;
  } finally { db.close(); }
}
