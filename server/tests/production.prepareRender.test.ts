import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareRenderEnvironment } from '../src/production/prepareRender.js';

describe('private Render environment preparation', () => {
  // Public-only fixture; no test-time OpenSSL dependency or private key.
  const certificate = Buffer.from(`-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUBE/OLOJJAajsS0GXHf6sQ6cb0EswDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbUHVibGljIHRlc3QgZml4dHVyZSBDQSBvbmx5MCAXDTI2
MTAzMTAyMDQ0NloYDzIxMjYxMDA3MDIwNDQ2WjAmMSQwIgYDVQQDDBtQdWJsaWMg
dGVzdCBmaXh0dXJlIENBIG9ubHkwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDXm367OBFV+uYlAZFQe6McDRJBbHl0dT/sjmeOV17Mzw2byZhm5JXK3afV
tcYd/qjNqbY705OHiK3Mq7ppgSqD9vL0F1hb8iT4NhKz93cgKryJK0/eI3IwSQ8A
qjmmLjs9Abse7HrqpO42VKZokgj/4qF+fEmI7VxfKnVTRnOqaaMT1bazIQuD7Mqr
TJGcaKj6CUl3k2Q4IJtbCTBwOHdH4P5ziRIae5aiAtgiZPJQsMCsKXvOGBkDSKbk
hgOzCUcdpShztZBt87DzC7niGOnG8hiTLz2390lnGgXJvlZ09rPOKBi0WhvAFAm9
JPwHTO5JvDHy8IFygnCABGEdYp2PAgMBAAGjUzBRMB0GA1UdDgQWBBRenndEvbMv
N8wOobinWIN5bby0lTAfBgNVHSMEGDAWgBRenndEvbMvN8wOobinWIN5bby0lTAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAzFartQA3yLl5g1TPE
gKm9bNNxoWWQeqc5ZZEkuftkXAkcjIHvt7/1H55Wups1bKOrVkdLakPJgthL4r9R
BOVgZEkPbx79YAKe6whGca62wkUu4GSkdHNy+OpPML0WEWF9zRbqZgL8oo8gLWcS
9HhF8w/oqB+ljgNfntKOU5IT6mq8pvVR8dgq6Kkpr38hP3mPVF3yeDjlSVNniKj/
8M3+ad/OHFEoqi1WfXv7Z4+VvqPzlXl9S3n6SATzNEUaBUiS0KFkWeUIrVAI+Q71
IZ1BOzPbiUHiPeoVAWe6cHLSEkl6s6Ve5CqQP2V13asrFDVfnf83PjT0orCmbQ98
davn
-----END CERTIFICATE-----
`);
  let directory: string;
  const now = new Date('2026-11-01T12:00:00.000Z');
  const password = 'a1'.repeat(36);
  const url = `postgresql://tamaya_runtime.fake-project:${password}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
  const secretFile = '# Local-only fixture\nDATABASE_URL=' + JSON.stringify(url) + '\n';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tamaya-render-test-'));
    await writeFile(join(directory, '.env.runtime.generated'), secretFile);
    await writeFile(join(directory, 'supabase-ca.crt'), certificate);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('prepares the minimum server settings, retains the runtime login and leaves source files unchanged', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const path = await prepareRenderEnvironment({ directory, now });
    const values = parseEnv(await readFile(path, 'utf8'));
    expect(values).toEqual({ APP_ENV: 'production', AUTH_MODE: 'firebase', HOST: '0.0.0.0', TRUST_PROXY_HOPS: '1',
      FIREBASE_PROJECT_ID: 'tamayaapp', DATABASE_URL: url, QR_SIGNING_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/),
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/secrets/firebase-admin.json', DATABASE_CA_PATH: '/etc/secrets/supabase-ca.crt' });
    expect(await readFile(join(directory, '.env.runtime.generated'), 'utf8')).toBe(secretFile);
    expect(await readFile(join(directory, 'supabase-ca.crt'))).toEqual(certificate);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('does not overwrite existing secrets or rotate their QR signature key on rerun', async () => {
    const path = await prepareRenderEnvironment({ directory, now });
    const original = await readFile(path, 'utf8');
    await expect(prepareRenderEnvironment({ directory, now })).rejects.toMatchObject({ diagnosticCode: 'RENDER_OUTPUT_EXISTS' });
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('generates an independent QR secret for a separate initial configuration', async () => {
    const first = parseEnv(await readFile(await prepareRenderEnvironment({ directory, now }), 'utf8')).QR_SIGNING_SECRET;
    await rm(join(directory, '.env.render.generated'));
    const second = parseEnv(await readFile(await prepareRenderEnvironment({ directory, now }), 'utf8')).QR_SIGNING_SECRET;
    expect(first).not.toBe(second);
  });
  it.each([
    url.replace('tamaya_runtime.fake-project', 'postgres.fake-project'),
    url.replace(password, '[YOUR-PASSWORD]'),
    url.replace('pooler.supabase.com', 'attacker.example'),
    url + '?sslmode=no-verify',
  ])('rejects non-runtime or insecure configuration without exposing it', async (invalid) => {
    await writeFile(join(directory, '.env.runtime.generated'), 'DATABASE_URL=' + JSON.stringify(invalid));
    try { await prepareRenderEnvironment({ directory, now }); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ diagnosticCode: 'RENDER_RUNTIME_INVALID' });
      expect(String(error)).not.toContain(password); expect(String(error)).not.toContain('postgresql://');
    }
    await expect(stat(join(directory, '.env.render.generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports a missing credential file without creating output', async () => {
    await rm(join(directory, '.env.runtime.generated'));
    await expect(prepareRenderEnvironment({ directory, now })).rejects.toMatchObject({ diagnosticCode: 'RENDER_RUNTIME_MISSING' });
    await expect(stat(join(directory, '.env.render.generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires a certificate file before producing an import configuration', async () => {
    await rm(join(directory, 'supabase-ca.crt'));
    await expect(prepareRenderEnvironment({ directory, now })).rejects.toMatchObject({ diagnosticCode: 'RENDER_CA_MISSING' });
  });
  it('rejects an HTML download error instead of accepting it as a CA', async () => {
    await writeFile(join(directory, 'supabase-ca.crt'), '<html>download error</html>');
    await expect(prepareRenderEnvironment({ directory, now })).rejects.toMatchObject({ diagnosticCode: 'RENDER_CA_INVALID' });
  });
  it('rejects an expired or not-yet-valid CA without modifying it', async () => {
    for (const now of [new Date('1970-01-01'), new Date('2200-01-01')]) {
      await expect(prepareRenderEnvironment({ directory, now })).rejects.toMatchObject({ diagnosticCode: 'RENDER_CA_INVALID' });
    }
    expect(await readFile(join(directory, 'supabase-ca.crt'))).toEqual(certificate);
  });
  it('validates project IDs without writing an arbitrary string into the env file', async () => {
    await expect(prepareRenderEnvironment({ directory, now, projectId: 'bad\nDATABASE_MIGRATION_URL=secret' })).rejects.toMatchObject({ diagnosticCode: 'RENDER_PROJECT_INVALID' });
  });
  it('runs the real CLI without printing credentials or the generated QR secret', async () => {
    const output = execFileSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'src/production/prepareRender.ts')], { cwd: directory, encoding: 'utf8' });
    const values = parseEnv(await readFile(join(directory, '.env.render.generated'), 'utf8'));
    expect(output).toContain('.env.render.generated');
    expect(output).not.toContain(password);
    expect(output).not.toContain(values.QR_SIGNING_SECRET);
    expect(output).not.toContain('postgresql://');
  });
});
