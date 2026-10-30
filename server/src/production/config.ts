import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreInfo } from '../../../shared/contracts.js';

export class ProductionConfigurationError extends Error {}

interface DatabaseConnectionConfig {
  databaseUrl: string;
  databaseSsl: false | { rejectUnauthorized: true; ca?: string };
}

export interface ProductionConfig extends DatabaseConnectionConfig {
  environment: 'local' | 'production'; authMode: 'firebase' | 'emulator';
  host: string; port: number; projectId: string; qrSecret: string;
  allowedOrigins: string[]; publicBaseUrl: string | null; storePath: string;
  emulatorHost?: string; trustProxyHops: number;
}

export function loadProductionEnvironment(): void {
  // Each deployment may inject process variables. Never overwrite them from a checked-in file.
  const path = process.env.ENV_FILE ?? '.env.production';
  if (existsSync(path)) process.loadEnvFile(path);
}

function configuredEnvironment(env: NodeJS.ProcessEnv): ProductionConfig['environment'] {
  const environment = env.APP_ENV ?? 'production';
  if (environment !== 'local' && environment !== 'production') throw new ProductionConfigurationError('APP_ENVはlocalかproductionを指定してください。');
  return environment;
}

function databaseConnectionConfig(env: NodeJS.ProcessEnv, environment: ProductionConfig['environment']): DatabaseConnectionConfig {
  let database: URL;
  try { database = new URL(env.DATABASE_URL?.trim() ?? ''); }
  catch { throw new ProductionConfigurationError('DATABASE_URLにPostgreSQLの接続情報を設定してください。'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)) {
    throw new ProductionConfigurationError('DATABASE_URLにPostgreSQLの接続情報を設定してください。');
  }
  const localDb = ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname);
  if (environment === 'production' && localDb) throw new ProductionConfigurationError('本番用DATABASE_URLに共有データベースの接続先を指定してください。');
  // pg URL SSL parameters may silently replace the secure Pool.ssl object; remove them.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat']) database.searchParams.delete(key);
  const databaseSsl = environment === 'local' && localDb
    ? false as const : { rejectUnauthorized: true as const, ...(env.DATABASE_CA_PATH ? { ca: readFileSync(env.DATABASE_CA_PATH, 'utf8') } : {}) };
  return { databaseUrl: database.toString(), databaseSsl };
}

/** Owner-run database setup does not require an HTTP server or Firebase configuration. */
export function databaseSetupConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConnectionConfig {
  return databaseConnectionConfig({ ...env, DATABASE_URL: env.DATABASE_MIGRATION_URL?.trim() || env.DATABASE_URL }, configuredEnvironment(env));
}

export function productionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ProductionConfigurationError(`${name}が未設定です。本番設定を確認してください。`);
    return value;
  };
  const environment = configuredEnvironment(env);
  const authMode = env.AUTH_MODE ?? 'firebase';
  if (authMode !== 'firebase' && authMode !== 'emulator') throw new ProductionConfigurationError('AUTH_MODEが正しくありません。');
  const host = env.HOST ?? (environment === 'local' ? '127.0.0.1' : '0.0.0.0');
  const port = Number(env.PORT ?? '3001');
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? '0');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 3 || (environment === 'local' && trustProxyHops !== 0)) {
    throw new ProductionConfigurationError('TRUST_PROXY_HOPSは本番の中継サーバー数0〜3を指定してください。ローカル検証では0だけ利用できます。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProductionConfigurationError('PORTは1〜65535を指定してください。');
  const projectId = required('FIREBASE_PROJECT_ID');
  if (!/^[a-z0-9][a-z0-9-]{3,62}$/.test(projectId)) throw new ProductionConfigurationError('FIREBASE_PROJECT_IDを確認してください。');
  const qrSecret = required('QR_SIGNING_SECRET');
  if (qrSecret.length < 32 || /^(?:change|replace|your|example)/i.test(qrSecret)) throw new ProductionConfigurationError('QR_SIGNING_SECRETには32文字以上の十分にランダムな秘密値が必要です。');
  const emulatorHost = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (authMode === 'emulator') {
    if (environment !== 'local' || env.NODE_ENV === 'production' || env.ALLOW_LOCAL_TEST_AUTH !== '1'
      || !['127.0.0.1', 'localhost', '::1'].includes(host) || !projectId.startsWith('demo-')
      || !emulatorHost || !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(emulatorHost)) {
      throw new ProductionConfigurationError('認証エミュレーターは明示したローカル検証環境でだけ利用できます。');
    }
  } else if (emulatorHost) {
    throw new ProductionConfigurationError('本番認証ではFIREBASE_AUTH_EMULATOR_HOSTを設定しないでください。');
  }
  const database = databaseConnectionConfig(env, environment);
  const allowedOrigins = (env.CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new ProductionConfigurationError('CORS_ORIGINSに有効な接続元URLを指定してください。'); }
    if (url.origin !== origin || (environment === 'production' && url.protocol !== 'https:')) {
      throw new ProductionConfigurationError('CORS_ORIGINSにはパスを含まないHTTPSの接続元だけを指定してください。');
    }
  }
  let publicBaseUrl: string | null = null;
  const publicBaseValue = env.PUBLIC_BASE_URL?.trim() ? env.PUBLIC_BASE_URL : env.RENDER_EXTERNAL_URL;
  if (publicBaseValue?.trim()) {
    let url: URL;
    try { url = new URL(publicBaseValue); }
    catch { throw new ProductionConfigurationError('PUBLIC_BASE_URLには管理サーバーのHTTPSオリジンを指定してください。'); }
    if (url.origin !== publicBaseValue || (environment === 'production' && url.protocol !== 'https:')) {
      throw new ProductionConfigurationError('PUBLIC_BASE_URLには管理サーバーのHTTPSオリジンを指定してください。');
    }
    publicBaseUrl = url.origin;
  }
  if (environment === 'production' && !publicBaseUrl) throw new ProductionConfigurationError('本番運用にはPUBLIC_BASE_URLが必要です。');
  return {
    environment, authMode, host, port, projectId, qrSecret, ...database,
    allowedOrigins, publicBaseUrl, emulatorHost, trustProxyHops,
    storePath: resolve(env.STORE_CONFIG_PATH ?? 'config/tamaya.json'),
  };
}

export function loadStoreConfiguration(config: ProductionConfig): StoreInfo {
  const raw = JSON.parse(readFileSync(config.storePath, 'utf8')) as StoreInfo;
  if (!raw || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) || !raw.name?.trim()
    || !raw.operator?.name?.trim() || !raw.operator?.phone?.trim()
    || !raw.legal?.termsVersion || !raw.legal?.privacyVersion
    || !raw.legal?.termsText?.trim() || !raw.legal?.privacyText?.trim() || !raw.legal?.supportText?.trim()
    || !Number.isInteger(raw.reward?.stampsRequired) || raw.reward.stampsRequired < 1
    || !Number.isInteger(raw.reward?.validityDays) || raw.reward.validityDays < 1
    || !Number.isSafeInteger(raw.reward.minimumPurchaseYen) || raw.reward.minimumPurchaseYen < 0 || raw.reward.minimumPurchaseYen > 100_000_000
    || !Number.isSafeInteger(raw.reward.redemptionMinimumPurchaseYen) || raw.reward.redemptionMinimumPurchaseYen < 0 || raw.reward.redemptionMinimumPurchaseYen > 100_000_000
    || raw.reward.dailyLimit !== 1 || raw.reward.timeZone !== 'Asia/Tokyo'
    || !Array.isArray(raw.products) || !Array.isArray(raw.reward.eligibleProducts)
    || (raw.reward.stampEligibleProducts !== undefined && (!Array.isArray(raw.reward.stampEligibleProducts) || raw.reward.stampEligibleProducts.some((value) => typeof value !== 'string' || !value.trim())))) {
    throw new ProductionConfigurationError('店舗設定ファイルの必須項目を確認してください。');
  }
  const benefit = raw.reward.benefit;
  if (raw.reward.operationsEnabled && (!benefit || !raw.reward.combinationRule?.trim()
    || !raw.reward.eligibleProducts.length || !raw.reward.version)) {
    throw new ProductionConfigurationError('特典内容・対象商品・併用条件が確定するまでスタンプ運用を有効にできません。');
  }
  if (benefit && (!benefit.label?.trim() || !['yen', 'percent', 'item'].includes(benefit.kind)
    || (benefit.kind !== 'item' && (!Number.isInteger(benefit.value) || benefit.value <= 0))
    || (benefit.kind === 'percent' && benefit.value > 100))) {
    throw new ProductionConfigurationError('特典の内容・割引額・割引率を確認してください。');
  }
  if (config.publicBaseUrl) raw.legal = {
    ...raw.legal,
    privacyUrl: `${config.publicBaseUrl}/privacy`, supportUrl: `${config.publicBaseUrl}/support`,
  };
  return raw;
}
