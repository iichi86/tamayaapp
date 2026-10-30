import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { promptDatabasePassword, resolveDatabasePasswordPlaceholder } from '../src/production/passwordPrompt.js';

const migrationUrl = 'postgresql://owner.project:[YOUR-PASSWORD]@pooler.example.com:5432/postgres';

describe('local database password entry', () => {
  it('substitutes an injected password safely without mutating the saved environment', async () => {
    const password = 'test-%:@/?#[]+&=日本語';
    const load = vi.fn(async () => password);
    const env = { DATABASE_MIGRATION_URL: migrationUrl, DATABASE_URL: 'postgresql://runtime:separate@db.example.com/postgres' };
    const resolved = await resolveDatabasePasswordPlaceholder(env, load);
    const database = new URL(resolved.DATABASE_MIGRATION_URL!);
    expect(decodeURIComponent(database.password)).toBe(password);
    expect(database.username).toBe('owner.project');
    expect(database.hostname).toBe('pooler.example.com');
    expect(database.pathname).toBe('/postgres');
    expect(resolved.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(env.DATABASE_MIGRATION_URL).toBe(migrationUrl);
    expect(load).toHaveBeenCalledOnce();
  });
  it('supports the runtime URL fallback and leaves complete credentials alone', async () => {
    const load = vi.fn(async () => 'test-password');
    const resolved = await resolveDatabasePasswordPlaceholder({ DATABASE_URL: migrationUrl }, load);
    expect(decodeURIComponent(new URL(resolved.DATABASE_URL!).password)).toBe('test-password');
    const complete = { DATABASE_MIGRATION_URL: 'postgresql://owner:provided@db.example.com/postgres' };
    expect(await resolveDatabasePasswordPlaceholder(complete, load)).toBe(complete);
    expect(load).toHaveBeenCalledOnce();
  });
  it('rejects placeholders outside the password field before requesting a password', async () => {
    const load = vi.fn(async () => 'test-password');
    await expect(resolveDatabasePasswordPlaceholder({ DATABASE_MIGRATION_URL: 'postgresql://owner:provided@db.example.com/[YOUR-PASSWORD]' }, load)).rejects.toThrow('パスワード欄');
    expect(load).not.toHaveBeenCalled();
  });
  it.each(['', 'test\npassword', 'test\rpassword'])('rejects empty or multiline supplied passwords', async (password) => {
    await expect(resolveDatabasePasswordPlaceholder({ DATABASE_MIGRATION_URL: migrationUrl }, async () => password)).rejects.toThrow('DBパスワード');
  });
  it('fails clearly without a local interactive terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    const output = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream;
    await expect(promptDatabasePassword(input, output)).rejects.toThrow('対話型ターミナル');
  });
  it('hides interactive keystrokes and restores terminal mode', async () => {
    const setRawMode = vi.fn();
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode }) as unknown as NodeJS.ReadStream;
    const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    let displayed = '';
    output.on('data', (data) => { displayed += String(data); });
    const password = promptDatabasePassword(input, output);
    input.emit('data', Buffer.from('test-hidden-password\r'));
    await expect(password).resolves.toBe('test-hidden-password');
    expect(displayed).not.toContain('test-hidden-password');
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });
  it('cancels without exposing typed characters and restores terminal mode', async () => {
    const setRawMode = vi.fn();
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode }) as unknown as NodeJS.ReadStream;
    const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    let displayed = '';
    output.on('data', (data) => { displayed += String(data); });
    const password = promptDatabasePassword(input, output);
    input.emit('data', Buffer.from('test-hidden-cancel\u0003'));
    await expect(password).rejects.toThrow('接続せずに終了');
    expect(displayed).not.toContain('test-hidden-cancel');
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });
});
