import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  connect: vi.fn(), end: vi.fn(), query: vi.fn(), release: vi.fn(), construct: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) { driver.construct(options); }
    connect = driver.connect;
    end = driver.end;
  },
}));

import { provisionRuntime } from '../src/production/provision.js';

describe('owner-run runtime credential provisioning', () => {
  let directory: string;
  let outputPath: string;
  const config = {
    databaseUrl: 'postgresql://postgres.fake-project:owner-password-do-not-log@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    databaseSsl: { rejectUnauthorized: true as const },
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'tamaya-provision-test-'));
    outputPath = join(directory, '.env.runtime.generated');
    driver.query.mockImplementation(async (sql: string) => ({ rowCount: sql.startsWith('SELECT') ? 0 : null, rows: [] }));
    driver.connect.mockResolvedValue({ query: driver.query, release: driver.release });
    driver.end.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function generatedUrl(): Promise<URL> {
    const contents = await readFile(outputPath, 'utf8');
    const value = contents.split('\n').find((line) => line.startsWith('DATABASE_URL='));
    expect(value).toBeDefined();
    return new URL(JSON.parse(value!.slice('DATABASE_URL='.length)) as string);
  }

  it('preserves the driver failure and removes only its own newly created output on connection failure', async () => {
    const failure = Object.assign(new Error('secret driver detail that must not become console output'), { code: '28P01' });
    driver.connect.mockRejectedValueOnce(failure);

    await expect(provisionRuntime(config, outputPath)).rejects.toBe(failure);

    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(driver.query).not.toHaveBeenCalled();
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('leaves an existing credential file untouched and does not connect', async () => {
    const original = 'Existing credential kept private and unchanged.\n';
    await writeFile(outputPath, original);

    await expect(provisionRuntime(config, outputPath)).rejects.toMatchObject({ diagnosticCode: 'DB_OUTPUT_EXISTS' });

    expect(await readFile(outputPath, 'utf8')).toBe(original);
    expect(driver.connect).not.toHaveBeenCalled();
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('rolls back without changing a pre-existing runtime role or retaining a newly created output', async () => {
    driver.query.mockImplementation(async (sql: string) => ({ rowCount: sql.startsWith('SELECT') ? 1 : null, rows: [] }));

    await expect(provisionRuntime(config, outputPath)).rejects.toMatchObject({ diagnosticCode: 'DB_RUNTIME_ROLE_EXISTS' });

    const statements = driver.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((sql) => /CREATE ROLE|ALTER ROLE|DROP ROLE/.test(sql))).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(driver.release).toHaveBeenCalledOnce();
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('rolls back an uncommitted role creation when role membership cannot be granted', async () => {
    const failure = Object.assign(new Error('permission detail'), { code: '42501' });
    driver.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('GRANT')) throw failure;
      return { rowCount: sql.startsWith('SELECT') ? 0 : null, rows: [] };
    });

    await expect(provisionRuntime(config, outputPath)).rejects.toBe(failure);

    const statements = driver.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the generated credential when COMMIT acknowledgement is lost', async () => {
    driver.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw Object.assign(new Error('connection reset after commit was sent'), { code: 'ECONNRESET' });
      return { rowCount: sql.startsWith('SELECT') ? 0 : null, rows: [] };
    });

    await expect(provisionRuntime(config, outputPath)).rejects.toMatchObject({ diagnosticCode: 'DB_COMMIT_UNCERTAIN' });

    const url = await generatedUrl();
    expect(url.username).toBe('tamaya_runtime.fake-project');
    expect(url.password).toMatch(/^[a-f0-9]{72}$/);
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('reports cleanup safely without masking the original connection failure', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('private original detail'), { code: '28P01' });
    driver.connect.mockRejectedValueOnce(failure);
    driver.end.mockRejectedValueOnce(new Error('private cleanup detail'));

    await expect(provisionRuntime(config, outputPath)).rejects.toBe(failure);

    expect(warning).toHaveBeenCalledOnce();
    const message = String(warning.mock.calls[0][0]);
    expect(message).toContain('[DB_CLEANUP_FAILED]');
    expect(message).not.toContain('private');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the original query failure when rollback and release also fail', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('private grant detail'), { code: '42501' });
    driver.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('GRANT')) throw failure;
      if (sql === 'ROLLBACK') throw new Error('private rollback detail');
      return { rowCount: sql.startsWith('SELECT') ? 0 : null, rows: [] };
    });
    driver.release.mockImplementationOnce(() => { throw new Error('private release detail'); });

    await expect(provisionRuntime(config, outputPath)).rejects.toBe(failure);

    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0][0])).toContain('[DB_CLEANUP_FAILED]');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
    expect(driver.end).toHaveBeenCalledOnce();
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists a restricted pooler login before committing and closes the connection', async () => {
    driver.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') {
        const url = await generatedUrl();
        expect(url.username).toBe('tamaya_runtime.fake-project');
        expect(url.password).toMatch(/^[a-f0-9]{72}$/);
      }
      return { rowCount: sql.startsWith('SELECT') ? 0 : null, rows: [] };
    });

    await provisionRuntime(config, outputPath);

    const url = await generatedUrl();
    expect(url.hostname).toBe('aws-0-ap-northeast-2.pooler.supabase.com');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/postgres');
    expect(url.password).not.toContain('owner-password');
    const statements = driver.query.mock.calls.map(([sql]) => String(sql));
    const creation = statements.find((sql) => sql.startsWith('CREATE ROLE'));
    expect(creation).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(statements).toContain('GRANT tamaya_api TO tamaya_runtime');
    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(driver.release).toHaveBeenCalledOnce();
    expect(driver.end).toHaveBeenCalledOnce();
    if (process.platform !== 'win32') expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });
});
