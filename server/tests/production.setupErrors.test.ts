import { describe, expect, it } from 'vitest';
import { ProductionConfigurationError } from '../src/production/config.js';
import { DatabaseSetupError, formatDatabaseSetupError } from '../src/production/setupErrors.js';

const secret = 'PRIVATE-DB-PASSWORD-DO-NOT-PRINT';
const privateUrl = `postgresql://owner:${secret}@private.example.test/private-db`;
function driverError(code: string): Error {
  return Object.assign(new Error(`Connection to ${privateUrl} failed`), {
    code, detail: secret, hint: privateUrl, stack: `Error: ${privateUrl}`,
  });
}

describe('secret-free database setup error diagnoses', () => {
  it.each([
    ['28P01', 'DB_AUTH_FAILED'], ['28000', 'DB_AUTH_FAILED'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'DB_TLS_CERTIFICATE'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'DB_TLS_CERTIFICATE'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DB_TLS_CERTIFICATE'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DB_TLS_CERTIFICATE'],
    ['CERT_HAS_EXPIRED', 'DB_TLS_CERTIFICATE'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'DB_TLS_CERTIFICATE'],
    ['ENOTFOUND', 'DB_DNS_FAILED'], ['EAI_AGAIN', 'DB_DNS_FAILED'],
    ['ECONNREFUSED', 'DB_NETWORK_FAILED'], ['ECONNRESET', 'DB_NETWORK_FAILED'],
    ['ETIMEDOUT', 'DB_NETWORK_FAILED'], ['ENETUNREACH', 'DB_NETWORK_FAILED'], ['EHOSTUNREACH', 'DB_NETWORK_FAILED'],
    ['42501', 'DB_PERMISSION_DENIED'],
    ['3F000', 'DB_SCHEMA_NOT_READY'], ['42P01', 'DB_SCHEMA_NOT_READY'], ['42704', 'DB_SCHEMA_NOT_READY'],
    ['42710', 'DB_RUNTIME_ROLE_EXISTS'],
  ])('classifies %s without printing database error text', (code, expected) => {
    const message = formatDatabaseSetupError(driverError(code));
    expect(message).toContain(`[${expected}]`);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(privateUrl);
    expect(message).not.toContain('private.example.test');
  });

  it('finds a diagnosis through nested causes and aggregate network errors', () => {
    const inner = new Error(privateUrl, { cause: driverError('SELF_SIGNED_CERT_IN_CHAIN') });
    expect(formatDatabaseSetupError(new Error(secret, { cause: inner }))).toContain('[DB_TLS_CERTIFICATE]');
    const aggregate = new AggregateError([new Error(secret), driverError('ECONNREFUSED')], privateUrl);
    expect(formatDatabaseSetupError(aggregate)).toContain('[DB_NETWORK_FAILED]');
  });

  it.each([
    'DB_OUTPUT_EXISTS', 'DB_OUTPUT_PERMISSION', 'DB_OUTPUT_WRITE_FAILED',
    'DB_RUNTIME_ROLE_EXISTS', 'DB_CLEANUP_FAILED', 'DB_COMMIT_UNCERTAIN',
  ])('preserves the explicit trusted setup stage %s instead of a nested driver cause', (code) => {
    const message = formatDatabaseSetupError(new DatabaseSetupError(code, { cause: driverError('28P01') }));
    expect(message).toContain(`[${code}]`);
    expect(message).not.toContain(secret);
  });

  it('distinguishes existing output from an existing DB role and advises preserving credentials', () => {
    const file = formatDatabaseSetupError(new DatabaseSetupError('DB_OUTPUT_EXISTS'));
    const role = formatDatabaseSetupError(new DatabaseSetupError('DB_RUNTIME_ROLE_EXISTS'));
    expect(file).toContain('上書きしていません');
    expect(role).toContain('ユーザーや設定ファイルを削除しないでください');
    expect(file).not.toBe(role);
  });

  it('preserves known controlled configuration guidance but suppresses unknown config text', () => {
    const known = 'DBパスワードが入力されなかったため、接続せずに終了しました。';
    expect(formatDatabaseSetupError(new ProductionConfigurationError(known))).toBe(`[DB_CONFIGURATION] ${known}`);
    const unknown = formatDatabaseSetupError(new ProductionConfigurationError(privateUrl));
    expect(unknown).toContain('[DB_CONFIGURATION]');
    expect(unknown).not.toContain(secret);
  });

  it.each(['Connection terminated due to connection timeout', 'timeout exceeded when trying to connect'])(
    'recognizes a pg-pool timeout without interpolating its message: %s', (message) => {
      expect(formatDatabaseSetupError(new Error(message))).toContain('[DB_NETWORK_FAILED]');
      expect(formatDatabaseSetupError(new Error(`${message}: ${privateUrl}`))).toContain('[DB_SETUP_UNKNOWN]');
    },
  );

  it.each([null, undefined, secret, new Error(privateUrl), driverError('UNRECOGNIZED'), { code: privateUrl }, new DatabaseSetupError(secret)])(
    'returns a safe generic diagnosis for unknown errors', (error) => {
      const message = formatDatabaseSetupError(error);
      expect(message).toContain('[DB_SETUP_UNKNOWN]');
      expect(message).not.toContain(secret);
      expect(message).not.toContain(privateUrl);
    },
  );

  it('terminates on cyclic causes and does not invoke error field getters', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(formatDatabaseSetupError(cyclic)).toContain('[DB_SETUP_UNKNOWN]');
    const unsafe = Object.create(null);
    for (const name of ['code', 'message', 'cause', 'errors']) Object.defineProperty(unsafe, name, { get: () => { throw new Error(secret); } });
    expect(formatDatabaseSetupError(unsafe)).toContain('[DB_SETUP_UNKNOWN]');
  });
});
