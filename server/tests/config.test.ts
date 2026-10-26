import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeConfig } from '../src/config.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('起動時の公開範囲とデータ分離', () => {
  it('開発用デモを外部公開アドレスまたはproduction環境では起動させない', () => {
    expect(() => runtimeConfig({ HOST: '0.0.0.0' }, ['--demo'])).toThrow('外部向け');
    expect(() => runtimeConfig({ NODE_ENV: 'production' }, ['--demo'])).toThrow('production');
  });
  it('デモが通常のDB設定を使わず、QR秘密値を再起動後も保持する', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tamaya-config-')); temporary.push(directory);
    const env = { DATABASE_PATH: join(directory, 'real.sqlite'), DEMO_DATABASE_PATH: join(directory, 'demo.sqlite') };
    const first = runtimeConfig(env, ['--demo']);
    const restarted = runtimeConfig(env, ['--demo']);
    expect(first.databasePath).toBe(env.DEMO_DATABASE_PATH);
    expect(first.databasePath).not.toBe(env.DATABASE_PATH);
    expect(first.qrSecret).toHaveLength(64);
    expect(restarted.qrSecret).toBe(first.qrSecret);
    expect(readFileSync(`${first.databasePath}.qr-key`, 'utf8')).toBe(first.qrSecret);
  });
  it('Firebaseモードは設定漏れを拒否し、デモへ自動で切り替えない', () => {
    expect(() => runtimeConfig({}, [])).toThrow('QR_SIGNING_SECRET');
    expect(() => runtimeConfig({ QR_SIGNING_SECRET: 'x'.repeat(64) }, [])).toThrow('FIREBASE_PROJECT_ID');
    expect(runtimeConfig({ QR_SIGNING_SECRET: 'x'.repeat(64), FIREBASE_PROJECT_ID: 'tamaya-real' }, []).demoMode).toBe(false);
  });
});
