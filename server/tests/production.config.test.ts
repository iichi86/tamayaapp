import { describe, expect, it } from 'vitest';
import { databaseSetupConfig, productionConfig } from '../src/production/config.js';
const base = { FIREBASE_PROJECT_ID: 'tamaya-project', QR_SIGNING_SECRET: 'random-secret-32-characters-minimum-long', DATABASE_URL: 'postgresql://api:password@db.example.com/tamaya', PUBLIC_BASE_URL: 'https://tamaya-api.example.com' };
describe('production deployment configuration', () => {
  it('fails closed when required external project settings are absent', () => {
    expect(() => productionConfig({})).toThrow('FIREBASE_PROJECT_ID'); expect(() => productionConfig({ ...base, DATABASE_URL: '' })).toThrow();
    expect(() => productionConfig({ ...base, PUBLIC_BASE_URL: undefined })).toThrow('PUBLIC_BASE_URL');
    expect(() => productionConfig({ ...base, QR_SIGNING_SECRET: '', RENDER_EXTERNAL_URL: 'https://example.onrender.com' })).toThrow('QR_SIGNING_SECRET');
    expect(() => productionConfig({ ...base, FIREBASE_PROJECT_ID: '', RENDER_EXTERNAL_URL: 'https://example.onrender.com' })).toThrow('FIREBASE_PROJECT_ID');
  });
  it('uses the Render HTTPS origin when the explicit public URL is absent or blank', () => {
    const render = 'https://example.onrender.com';
    expect(productionConfig({ ...base, PUBLIC_BASE_URL: undefined, RENDER_EXTERNAL_URL: render }).publicBaseUrl).toBe(render);
    expect(productionConfig({ ...base, PUBLIC_BASE_URL: '  ', RENDER_EXTERNAL_URL: render }).publicBaseUrl).toBe(render);
    expect(productionConfig({ ...base, RENDER_EXTERNAL_URL: 'invalid' }).publicBaseUrl).toBe(base.PUBLIC_BASE_URL);
    expect(() => productionConfig({ ...base, PUBLIC_BASE_URL: 'http://invalid.example.com', RENDER_EXTERNAL_URL: render })).toThrow('PUBLIC_BASE_URL');
  });
  it.each(['http://example.onrender.com', 'https://example.onrender.com/', 'https://example.onrender.com/path', 'https://example.onrender.com?query=1', 'https://user:password@example.onrender.com', 'invalid'])(
    'rejects an invalid Render origin: %s', (origin) => {
      expect(() => productionConfig({ ...base, PUBLIC_BASE_URL: undefined, RENDER_EXTERNAL_URL: origin })).toThrow('PUBLIC_BASE_URL');
    },
  );
  it('enforces TLS certificate checks even if the URL tries to weaken SSL', () => {
    const config = productionConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}?sslmode=no-verify&ssl=0&sslnegotiation=direct&uselibpqcompat=true` }); expect(config.databaseSsl).toEqual({ rejectUnauthorized: true }); expect(config.databaseUrl).not.toContain('ssl');
    expect(productionConfig({ ...base, TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1); expect(() => productionConfig({ ...base, TRUST_PROXY_HOPS: 'true' })).toThrow(); expect(() => productionConfig({ ...base, CORS_ORIGINS: '*' })).toThrow(); expect(() => productionConfig({ ...base, CORS_ORIGINS: 'http://example.com' })).toThrow();
  });
  it('only allows explicitly selected auth emulation on loopback in a local demo project', () => {
    const local = { ...base, APP_ENV: 'local', AUTH_MODE: 'emulator', ALLOW_LOCAL_TEST_AUTH: '1', FIREBASE_PROJECT_ID: 'demo-tamaya-production', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test', HOST: '127.0.0.1' };
    expect(productionConfig(local).databaseSsl).toBe(false); expect(() => productionConfig({ ...local, APP_ENV: 'production' })).toThrow();
    expect(() => productionConfig({ ...local, HOST: '0.0.0.0' })).toThrow(); expect(() => productionConfig({ ...local, TRUST_PROXY_HOPS: '1' })).toThrow(); expect(() => productionConfig({ ...local, NODE_ENV: 'production' })).toThrow();
    expect(() => productionConfig({ ...base, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow();
  });
});

describe('owner-run database setup configuration', () => {
  it('accepts migration credentials alone without HTTP, Firebase, or QR settings', () => {
    const config = databaseSetupConfig({ DATABASE_MIGRATION_URL: base.DATABASE_URL });
    expect(config).toEqual({ databaseUrl: base.DATABASE_URL, databaseSsl: { rejectUnauthorized: true } });
    expect(databaseSetupConfig({ DATABASE_MIGRATION_URL: base.DATABASE_URL, DATABASE_URL: 'invalid' })).toEqual(config);
  });
  it('retains the DATABASE_URL fallback when migration credentials are absent or blank', () => {
    expect(databaseSetupConfig({ DATABASE_URL: base.DATABASE_URL }).databaseUrl).toBe(base.DATABASE_URL);
    expect(databaseSetupConfig({ DATABASE_MIGRATION_URL: '  ', DATABASE_URL: base.DATABASE_URL }).databaseUrl).toBe(base.DATABASE_URL);
  });
  it('strips all pg SSL overrides while keeping certificate verification on remote connections', () => {
    const url = `${base.DATABASE_URL}?ssl=0&sslmode=no-verify&sslcert=ignored&sslkey=ignored&sslrootcert=ignored&sslnegotiation=direct&uselibpqcompat=true&application_name=setup`;
    const config = databaseSetupConfig({ DATABASE_MIGRATION_URL: url, APP_ENV: 'local' });
    expect(config.databaseSsl).toEqual({ rejectUnauthorized: true });
    expect(new URL(config.databaseUrl).search).toBe('?application_name=setup');
    expect(() => databaseSetupConfig({ DATABASE_MIGRATION_URL: url, DATABASE_CA_PATH: '/does-not-exist/tamaya-ca.pem' })).toThrow();
  });
  it('only disables TLS for explicitly local loopback databases', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const url = `postgresql://test:test@${host}/test`;
      expect(databaseSetupConfig({ DATABASE_MIGRATION_URL: url, APP_ENV: 'local' }).databaseSsl).toBe(false);
      expect(() => databaseSetupConfig({ DATABASE_MIGRATION_URL: url })).toThrow('共有データベース');
    }
  });
  it.each([{}, { APP_ENV: 'unknown', DATABASE_MIGRATION_URL: base.DATABASE_URL }, { DATABASE_MIGRATION_URL: 'https://db.example.com/tamaya' }, { DATABASE_MIGRATION_URL: 'postgresql://db.example.com/' }])(
    'fails closed on missing or invalid database setup settings', (env) => {
      expect(() => databaseSetupConfig(env)).toThrow();
    },
  );
});
