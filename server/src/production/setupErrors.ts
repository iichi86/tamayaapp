import { ProductionConfigurationError } from './config.js';

/** A trusted setup stage, separate from untrusted database/server error text. */
export class DatabaseSetupError extends Error {
  constructor(readonly diagnosticCode: string, options?: ErrorOptions) {
    super('Database setup failed', options);
    this.name = 'DatabaseSetupError';
  }
}

const explanations: Readonly<Record<string, string>> = {
  DB_AUTH_FAILED: 'SupabaseのDBパスワードによる認証に失敗しました。新しいDBパスワードの設定完了と、初期準備用ユーザー名を確認してください。',
  DB_TLS_CERTIFICATE: 'DBのTLS証明書を検証できませんでした。提供元のCA証明書とDATABASE_CA_PATHの設定を確認してください。証明書の検証を無効にせず、開発担当へこのコードを伝えてください。',
  DB_DNS_FAILED: 'DBの接続先を名前解決できませんでした。接続先ホスト名とPCのインターネット接続を確認してください。',
  DB_NETWORK_FAILED: 'DBへの通信を完了できませんでした。ネットワークの制限とSupabaseの稼働状態を確認してください。',
  DB_PERMISSION_DENIED: 'DBの初期準備に必要な権限がありません。初期準備用の所有者接続情報と、SQLの適用状況を確認してください。',
  DB_SCHEMA_NOT_READY: '必要なDBスキーマまたは権限用ロールが見つかりません。初期SQLの適用状況を確認してください。',
  DB_RUNTIME_ROLE_EXISTS: '実行専用DBユーザーがすでに存在します。既存の接続設定を保管したまま、開発担当へこのコードを伝えてください。ユーザーや設定ファイルを削除しないでください。',
  DB_OUTPUT_EXISTS: '接続設定の生成ファイルがすでに存在します。既存ファイルは上書きしていません。ファイルを保管したまま、開発担当へこのコードを伝えてください。',
  DB_OUTPUT_PERMISSION: '接続設定ファイルを保存する権限がありません。現在のserverフォルダーへの書き込み権限を確認してください。',
  DB_OUTPUT_WRITE_FAILED: '接続設定ファイルを保存できませんでした。空き容量と保存先の状態を確認し、開発担当へこのコードを伝えてください。',
  DB_CLEANUP_FAILED: '生成途中の接続設定ファイルの後片付けを完了できませんでした。ファイルを共有・削除せず、開発担当へこのコードを伝えてください。',
  DB_COMMIT_UNCERTAIN: 'DBでの確定結果を確認できませんでした。生成された接続設定を保管したまま、開発担当へこのコードを伝えてください。',
  DB_CONFIGURATION: 'DBの初期準備用設定を確認してください。秘密値を共有せず、開発担当へこのコードを伝えてください。',
  DB_SETUP_UNKNOWN: 'DBの初期準備を完了できませんでした。秘密値を共有せず、開発担当へこのコードを伝えてください。',
};

// These are application-authored messages only. Never print arbitrary Error.message,
// including a ProductionConfigurationError constructed with an unknown message.
const safeConfigurationMessages = new Set([
  'APP_ENVはlocalかproductionを指定してください。',
  'DATABASE_URLにPostgreSQLの接続情報を設定してください。',
  '本番用DATABASE_URLに共有データベースの接続先を指定してください。',
  'DB接続情報の[YOUR-PASSWORD]はパスワード欄にだけ指定してください。',
  'DBパスワードの非表示入力には対話型ターミナルが必要です。PCのコマンド画面で実行するか、管理用接続情報を非公開のローカル設定へ登録してください。',
  'DBパスワードが入力されなかったため、接続せずに終了しました。',
  'DBパスワードを確認してください。接続情報は保存していません。',
]);

const externalCodes: Readonly<Record<string, string>> = {
  '28P01': 'DB_AUTH_FAILED', '28000': 'DB_AUTH_FAILED',
  SELF_SIGNED_CERT_IN_CHAIN: 'DB_TLS_CERTIFICATE',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'DB_TLS_CERTIFICATE',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'DB_TLS_CERTIFICATE',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'DB_TLS_CERTIFICATE',
  CERT_HAS_EXPIRED: 'DB_TLS_CERTIFICATE',
  ERR_TLS_CERT_ALTNAME_INVALID: 'DB_TLS_CERTIFICATE',
  ENOTFOUND: 'DB_DNS_FAILED', EAI_AGAIN: 'DB_DNS_FAILED',
  ECONNREFUSED: 'DB_NETWORK_FAILED', ECONNRESET: 'DB_NETWORK_FAILED',
  ETIMEDOUT: 'DB_NETWORK_FAILED', ENETUNREACH: 'DB_NETWORK_FAILED', EHOSTUNREACH: 'DB_NETWORK_FAILED',
  '42501': 'DB_PERMISSION_DENIED',
  '3F000': 'DB_SCHEMA_NOT_READY', '42P01': 'DB_SCHEMA_NOT_READY', '42704': 'DB_SCHEMA_NOT_READY',
  '42710': 'DB_RUNTIME_ROLE_EXISTS',
};

// Reading data properties avoids invoking an error object's custom getters.
function field(error: unknown, name: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try { return Object.getOwnPropertyDescriptor(error, name)?.value; }
  catch { return undefined; }
}

function result(code: string): string {
  return `[${code}] ${explanations[code]}`;
}

/** Return an allowlisted diagnosis, never a password, connection URL or server text. */
export function formatDatabaseSetupError(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  // Bound traversal of nested/aggregate failures and tolerate cycles.
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const current = pending[index];
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof DatabaseSetupError) {
      const code = current.diagnosticCode;
      if (Object.hasOwn(explanations, code)) return result(code);
    }
    if (current instanceof ProductionConfigurationError) {
      const message = field(current, 'message');
      if (typeof message === 'string' && safeConfigurationMessages.has(message)) return `[DB_CONFIGURATION] ${message}`;
      return result('DB_CONFIGURATION');
    }
    const code = field(current, 'code');
    if (typeof code === 'string' && Object.hasOwn(externalCodes, code)) return result(externalCodes[code]);
    // pg-pool sometimes omits code for these exact library-authored messages.
    const message = field(current, 'message');
    if (message === 'Connection terminated due to connection timeout' || message === 'timeout exceeded when trying to connect') return result('DB_NETWORK_FAILED');
    const cause = field(current, 'cause');
    if (cause !== undefined) pending.push(cause);
    const children = field(current, 'errors');
    if (Array.isArray(children)) pending.push(...children.slice(0, 16));
  }
  return result('DB_SETUP_UNKNOWN');
}
