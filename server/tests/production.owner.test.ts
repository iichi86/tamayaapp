import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  initialize: vi.fn(), credential: vi.fn(), deleteApp: vi.fn(), getUser: vi.fn(),
  pool: vi.fn(), query: vi.fn(), poolEnd: vi.fn(), close: vi.fn(), bootstrap: vi.fn(), upsert: vi.fn(),
}));
vi.mock('firebase-admin/app', () => ({ cert: driver.credential, initializeApp: driver.initialize, deleteApp: driver.deleteApp }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ getUser: driver.getUser }) }));
vi.mock('pg', () => ({ Pool: class { constructor(config: unknown) { driver.pool(config); } query = driver.query; end = driver.poolEnd; } }));
vi.mock('../src/production/database.js', () => ({
  PostgresDatabase: class { bootstrapOwner = driver.bootstrap; close = driver.close; upsertStore = driver.upsert; },
}));

import { bootstrapProductionOwner } from '../src/production/owner.js';

describe('trusted initial owner setup', () => {
  let directory: string;
  let credentialsPath: string;
  let storePath: string;
  let env: NodeJS.ProcessEnv;
  const originalEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const account = { type: 'service_account', project_id: 'tamayaapp',
    client_email: 'local-fixture@tamayaapp.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nFAKE-LOCAL-TEST-KEY-NOT-A-SECRET\n-----END PRIVATE KEY-----\n' };
  beforeEach(async () => {
    vi.resetAllMocks();
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    directory = await mkdtemp(join(tmpdir(), 'tamaya-owner-test-'));
    credentialsPath = join(directory, 'firebase-admin.json');
    storePath = join(directory, 'store.json');
    await writeFile(credentialsPath, JSON.stringify(account));
    await writeFile(storePath, JSON.stringify({ id: 'tamaya', legal: { privacyUrl: null } }));
    env = { APP_ENV: 'production', AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'tamayaapp',
      DATABASE_MIGRATION_URL: 'postgresql://postgres.fixture:fake-owner-password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
      DATABASE_URL: 'invalid-runtime-setting-is-not-used', GOOGLE_APPLICATION_CREDENTIALS: credentialsPath, STORE_CONFIG_PATH: storePath };
    driver.credential.mockReturnValue({ local: true });
    driver.initialize.mockReturnValue({ name: 'local-owner-test' });
    driver.deleteApp.mockResolvedValue(undefined);
    driver.getUser.mockResolvedValue({ uid: 'owner-uid', emailVerified: true, disabled: false });
    driver.query.mockResolvedValue({ rows: [{ firebase_project_id: 'tamayaapp' }] });
    driver.bootstrap.mockResolvedValue(undefined); driver.close.mockResolvedValue(undefined); driver.poolEnd.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalEmulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = originalEmulator;
    await rm(directory, { recursive: true, force: true });
  });

  it('uses administrative DB settings without requiring HTTP or QR settings and preserves live store configuration', async () => {
    const before = await readFile(storePath, 'utf8');
    await bootstrapProductionOwner({ uid: 'owner-uid', env });
    expect(driver.getUser).toHaveBeenCalledWith('owner-uid');
    expect(driver.pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: env.DATABASE_MIGRATION_URL, ssl: { rejectUnauthorized: true } }));
    expect(driver.query).toHaveBeenCalledWith('SELECT firebase_project_id FROM tamaya.stores WHERE id=$1', ['tamaya']);
    expect(driver.bootstrap).toHaveBeenCalledExactlyOnceWith('tamaya', 'owner-uid');
    expect(driver.upsert).not.toHaveBeenCalled();
    expect(await readFile(storePath, 'utf8')).toBe(before);
    expect(driver.close).toHaveBeenCalledOnce(); expect(driver.deleteApp).toHaveBeenCalledOnce();
  });

  it('accepts an explicitly selected local credentials path without changing environment files', async () => {
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    await bootstrapProductionOwner({ uid: 'owner-uid', env, credentialsPath });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(driver.bootstrap).toHaveBeenCalledOnce();
  });

  it.each(['', 'bad uid', 'a'.repeat(129), 'uid\n'])('rejects an invalid UID before accessing Firebase or DB', async (uid) => {
    await expect(bootstrapProductionOwner({ uid, env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_UID_REQUIRED' });
    expect(driver.initialize).not.toHaveBeenCalled(); expect(driver.pool).not.toHaveBeenCalled();
  });

  it.each([
    { AUTH_MODE: 'emulator' }, { APP_ENV: 'local' }, { FIREBASE_PROJECT_ID: 'demo-tamayaapp' },
    { FIREBASE_PROJECT_ID: '' }, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
  ])('rejects non-production Firebase settings', async (override) => {
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env: { ...env, ...override } })).rejects.toMatchObject({ diagnosticCode: 'OWNER_CONFIGURATION' });
    expect(driver.getUser).not.toHaveBeenCalled(); expect(driver.pool).not.toHaveBeenCalled();
  });

  it('also rejects an emulator host inherited by the real Firebase SDK process', async () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_CONFIGURATION' });
  });

  it('requires owner setup credentials rather than silently using the hosted runtime settings', async () => {
    delete env.DATABASE_MIGRATION_URL;
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_DATABASE_ADMIN_REQUIRED' });
    expect(driver.pool).not.toHaveBeenCalled();
  });

  it('requires a local Admin JSON before requesting a DB password', async () => {
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    const readPassword = vi.fn();
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env, readPassword })).rejects.toMatchObject({ diagnosticCode: 'OWNER_CREDENTIALS_REQUIRED' });
    expect(readPassword).not.toHaveBeenCalled();
  });

  it('rejects Admin credentials for another Firebase project without exposing their contents', async () => {
    await writeFile(credentialsPath, JSON.stringify({ ...account, project_id: 'other-project' }));
    try { await bootstrapProductionOwner({ uid: 'owner-uid', env }); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toMatchObject({ diagnosticCode: 'OWNER_CREDENTIALS_PROJECT' });
      expect(String(error)).not.toContain(account.private_key); expect(String(error)).not.toContain(credentialsPath);
    }
    expect(driver.initialize).not.toHaveBeenCalled(); expect(driver.pool).not.toHaveBeenCalled();
  });

  it('turns malformed JSON or private SDK credential errors into safe diagnostics', async () => {
    await writeFile(credentialsPath, '<private invalid JSON>');
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_CREDENTIALS_INVALID' });
    await writeFile(credentialsPath, JSON.stringify(account));
    driver.credential.mockImplementationOnce(() => { throw new Error('private-key-with-secret'); });
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_CREDENTIALS_INVALID' });
  });

  it.each([
    [{ uid: 'owner-uid', emailVerified: false, disabled: false }, 'OWNER_ACCOUNT_NOT_VERIFIED'],
    [{ uid: 'owner-uid', emailVerified: true, disabled: true }, 'OWNER_ACCOUNT_DISABLED'],
    [{ uid: 'another-uid', emailVerified: true, disabled: false }, 'OWNER_AUTH_FAILED'],
  ])('rejects an unverified, disabled, or different account before asking for the DB password', async (user, code) => {
    driver.getUser.mockResolvedValueOnce(user);
    const readPassword = vi.fn();
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env, readPassword })).rejects.toMatchObject({ diagnosticCode: code });
    expect(readPassword).not.toHaveBeenCalled(); expect(driver.pool).not.toHaveBeenCalled(); expect(driver.deleteApp).toHaveBeenCalledOnce();
  });

  it('classifies absent accounts and hides all other Firebase error messages', async () => {
    driver.getUser.mockRejectedValueOnce({ code: 'auth/user-not-found', message: 'private server text' });
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_ACCOUNT_NOT_FOUND' });
    driver.getUser.mockRejectedValueOnce(new Error('private server credential text'));
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_AUTH_FAILED' });
    expect(driver.pool).not.toHaveBeenCalled();
  });

  it('will not bootstrap a store missing from the shared DB', async () => {
    driver.query.mockResolvedValueOnce({ rows: [] });
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_STORE_NOT_READY' });
    expect(driver.bootstrap).not.toHaveBeenCalled(); expect(driver.close).toHaveBeenCalledOnce(); expect(driver.deleteApp).toHaveBeenCalledOnce();
  });

  it('requires the existing store to use the same Firebase project before granting ownership', async () => {
    driver.query.mockResolvedValueOnce({ rows: [{ firebase_project_id: 'other-project' }] });
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toMatchObject({ diagnosticCode: 'OWNER_STORE_PROJECT' });
    expect(driver.bootstrap).not.toHaveBeenCalled(); expect(driver.upsert).not.toHaveBeenCalled();
  });

  it('reads and safely encodes the admin password only after the verified account is ready', async () => {
    env.DATABASE_MIGRATION_URL = env.DATABASE_MIGRATION_URL!.replace('fake-owner-password', '[YOUR-PASSWORD]');
    const password = 'test-:@/%password';
    const readPassword = vi.fn(async () => {
      expect(driver.getUser).toHaveBeenCalledWith('owner-uid');
      return password;
    });
    await bootstrapProductionOwner({ uid: 'owner-uid', env, readPassword });
    expect(readPassword).toHaveBeenCalledOnce();
    expect(decodeURIComponent(new URL(driver.pool.mock.calls[0][0].connectionString).password)).toBe(password);
    expect(env.DATABASE_MIGRATION_URL).toContain('[YOUR-PASSWORD]');
  });

  it('keeps the original DB failure when cleanup fails and emits no secret messages', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('private database URL and password'), { code: '42501' });
    driver.query.mockRejectedValueOnce(failure); driver.close.mockRejectedValueOnce(new Error('private close failure'));
    driver.deleteApp.mockRejectedValueOnce(new Error('private Firebase close failure'));
    await expect(bootstrapProductionOwner({ uid: 'owner-uid', env })).rejects.toBe(failure);
    expect(log).toHaveBeenCalledOnce(); expect(String(log.mock.calls[0][0])).toContain('[OWNER_CLEANUP_FAILED]');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private'); expect(driver.bootstrap).not.toHaveBeenCalled();
  });
});
