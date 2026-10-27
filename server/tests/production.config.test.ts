import { describe, expect, it } from 'vitest';
import { productionConfig } from '../src/production/config.js';
const base = { FIREBASE_PROJECT_ID: 'tamaya-project', QR_SIGNING_SECRET: 'random-secret-32-characters-minimum-long', DATABASE_URL: 'postgresql://api:password@db.example.com/tamaya', PUBLIC_BASE_URL: 'https://tamaya-api.example.com' };
describe('production deployment configuration', () => {
  it('fails closed when required external project settings are absent', () => {
    expect(() => productionConfig({})).toThrow('FIREBASE_PROJECT_ID'); expect(() => productionConfig({ ...base, DATABASE_URL: '' })).toThrow();
    expect(() => productionConfig({ ...base, PUBLIC_BASE_URL: undefined })).toThrow('PUBLIC_BASE_URL');
  });
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
