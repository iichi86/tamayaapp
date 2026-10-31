import { describe, expect, it, vi } from 'vitest';
import { parseOwnerArguments, pickOwnerCredentialsFile } from '../src/production/owner.js';

describe('local owner setup file selection', () => {
  it('accepts the file picker before or after the explicit target UID', () => {
    for (const args of [['--uid', 'test-owner', '--pick-credentials'], ['--pick-credentials', '--uid', 'test-owner']]) {
      expect(parseOwnerArguments(args)).toEqual({ uid: 'test-owner', credentialsPath: undefined, pickCredentials: true });
    }
  });

  it('retains the explicit credentials path option for existing command line users', () => {
    const path = 'C:\\Users\\Example\\玉屋 秘密設定\\firebase-admin.json';
    expect(parseOwnerArguments(['--uid', 'test-owner', '--credentials', path])).toEqual({ uid: 'test-owner', credentialsPath: path, pickCredentials: false });
  });

  it.each([
    [], ['--pick-credentials'], ['--uid'], ['--uid', '--pick-credentials'],
    ['--uid', 'test-owner', '--uid', 'different-owner'],
    ['--uid', 'test-owner', '--pick-credentials', '--pick-credentials'],
    ['--uid', 'test-owner', '--unknown', 'value'],
    ['--uid', 'test-owner', '--credentials', 'file.json', '--pick-credentials'],
  ])('rejects ambiguous or incomplete arguments without executing a selection: %j', (args) => {
    expect(() => parseOwnerArguments(args)).toThrow();
  });

  it('accepts a selected absolute JSON path containing spaces and Japanese characters', () => {
    const selected = 'C:\\Users\\Example\\玉屋 秘密設定\\firebase-admin.json';
    expect(pickOwnerCredentialsFile({ platform: 'win32', select: () => selected + '\r\n' })).toBe(selected);
  });

  it('does not print the selected local path', () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      pickOwnerCredentialsFile({ platform: 'win32', select: () => 'C:\\PRIVATE-PATH\\firebase-admin.json' });
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it('stops when the picker is cancelled', () => {
    expect(() => pickOwnerCredentialsFile({ platform: 'win32', select: () => '' })).toThrow('[OWNER_FILE_SELECTION_CANCELLED]');
    expect(() => pickOwnerCredentialsFile({ platform: 'win32', select: () => { throw { status: 3 }; } })).toThrow('[OWNER_FILE_SELECTION_CANCELLED]');
  });

  it.each(['relative.json', 'C:\\PRIVATE-PATH\\key.txt', 'C:\\PRIVATE-PATH\\key\n.json', 'C:\\PRIVATE-PATH\\key\0.json'])('rejects an invalid selection without exposing it', (selected) => {
    try { pickOwnerCredentialsFile({ platform: 'win32', select: () => selected }); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ diagnosticCode: 'OWNER_CREDENTIALS_INVALID' });
      expect(String(error)).not.toContain('PRIVATE-PATH');
    }
  });

  it('hides a picker process error and provides a static fallback code', () => {
    try { pickOwnerCredentialsFile({ platform: 'win32', select: () => { throw new Error('PRIVATE-PROCESS-OUTPUT'); } }); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ diagnosticCode: 'OWNER_FILE_PICKER_UNAVAILABLE' });
      expect(String(error)).not.toContain('PRIVATE-PROCESS-OUTPUT');
    }
  });

  it('does not run a Windows dialog on another operating system', () => {
    const select = vi.fn(() => 'C:\\test.json');
    expect(() => pickOwnerCredentialsFile({ platform: 'linux', select })).toThrow('[OWNER_FILE_PICKER_UNAVAILABLE]');
    expect(select).not.toHaveBeenCalled();
  });
});
