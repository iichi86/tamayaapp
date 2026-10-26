import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import type { DatabasePort, Store } from './types.js';
import { DomainError } from './types.js';

export function loadEnvironment(): void {
  if (existsSync('.env')) loadEnvFile('.env');
}

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  const demoMode = argv.includes('--demo');
  const host = env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTは1〜65535で設定してください。');
  if (demoMode && (env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(host))) {
    throw new Error('開発用デモはproduction環境や外部向けアドレスでは起動できません。HOST=127.0.0.1で使ってください。');
  }
  const databasePath = resolve(demoMode ? (env.DEMO_DATABASE_PATH ?? 'data/demo.sqlite') : (env.DATABASE_PATH ?? 'data/tamaya.sqlite'));
  let qrSecret = env.QR_SIGNING_SECRET ?? '';
  if (demoMode && !qrSecret) {
    const keyPath = `${databasePath}.qr-key`;
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    qrSecret = readFileSync(keyPath, 'utf8').trim();
  }
  if (qrSecret.length < 32) throw new Error('QR_SIGNING_SECRETに32文字以上のランダムな秘密値を設定してください。');
  if (!demoMode && !env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_IDに運営者のFirebaseプロジェクトIDを設定してください。');
  return { demoMode, host, port, databasePath, qrSecret,
    allowedOrigins: (env.CORS_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean) };
}

export function ensureConfiguredStore(db: DatabasePort, env: NodeJS.ProcessEnv = process.env): Store {
  const store: Store = {
    id: env.STORE_ID ?? 'tamaya', name: env.STORE_NAME ?? 'むさしの玉屋',
    firebaseProjectId: env.FIREBASE_PROJECT_ID ?? '',
    stampsRequired: 10, discountYen: 100, validityDays: 30,
  };
  if (!store.firebaseProjectId) throw new Error('FIREBASE_PROJECT_IDが必要です。');
  try {
    const existing = db.getStore(store.id);
    if (existing.firebaseProjectId !== store.firebaseProjectId) throw new Error('既存店舗のFirebaseプロジェクトIDと設定が一致しません。');
    return existing;
  } catch (error) {
    if (!(error instanceof DomainError) || error.statusCode !== 404) throw error;
    return db.createStore(store);
  }
}
