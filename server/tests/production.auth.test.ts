import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), deleteUser: vi.fn(), getUser: vi.fn(), initialize: vi.fn(), credential: vi.fn() }));
vi.mock('firebase-admin/app', () => ({ getApps: () => [], initializeApp: mocks.initialize, applicationDefault: mocks.credential }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verify, deleteUser: mocks.deleteUser, getUser: mocks.getUser }) }));
import { createFirebaseIdentityProvider } from '../src/production/auth.js';
const projectId = 'test-project';
const decoded = { uid: 'uid-1', aud: projectId, iss: `https://securetoken.google.com/${projectId}`, email_verified: true, auth_time: 1000 };
const previous = process.env.FIREBASE_AUTH_EMULATOR_HOST;
beforeEach(() => { vi.resetAllMocks(); delete process.env.FIREBASE_AUTH_EMULATOR_HOST; mocks.verify.mockResolvedValue(decoded); });
afterEach(() => { if (previous === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST; else process.env.FIREBASE_AUTH_EMULATOR_HOST = previous; });
describe('production Firebase login-only adapter', () => {
  it('checks signature, expiry, disabled/revoked state and email confirmation', async () => {
    const provider = createFirebaseIdentityProvider({ projectId, mode: 'firebase', now: () => new Date(1_000_000) });
    expect(await provider.verify('id-token')).toEqual({ uid: 'uid-1', projectId, emailVerified: true, authTime: 1000 }); expect(mocks.verify).toHaveBeenCalledWith('id-token', true);
    mocks.verify.mockResolvedValueOnce({ ...decoded, email_verified: false }); await expect(provider.verify('id-token')).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED', statusCode: 403 });
    mocks.verify.mockResolvedValueOnce({ ...decoded, email_verified: false });
    expect(await provider.verify('id-token', { allowUnverified: true })).toMatchObject({ emailVerified: false });
    mocks.verify.mockRejectedValueOnce(new Error('revoked private error')); await expect(provider.verify('id-token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED', statusCode: 401 });
  });
  it('rejects wrong audience/issuer and impossible recent-login timestamps', async () => {
    const provider = createFirebaseIdentityProvider({ projectId, mode: 'firebase', now: () => new Date(1_000_000) });
    for (const value of [{ ...decoded, aud: 'another-project' }, { ...decoded, iss: 'https://attacker' }, { ...decoded, auth_time: 2000 }]) {
      mocks.verify.mockResolvedValueOnce(value); await expect(provider.verify('id-token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });
  it('forbids emulator configuration in normal mode', () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'; expect(() => createFirebaseIdentityProvider({ projectId, mode: 'firebase' })).toThrow();
    expect(() => createFirebaseIdentityProvider({ projectId, mode: 'emulator', emulatorHost: 'attacker:9099' })).toThrow();
  });
  it('rejects nonexistent, disabled and unverified staff handover targets', async () => {
    const provider = createFirebaseIdentityProvider({ projectId, mode: 'firebase' });
    mocks.getUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    await expect(provider.verifyStaffUid('phantom')).rejects.toMatchObject({ code: 'STAFF_ACCOUNT_NOT_READY' });
    for (const value of [{ emailVerified: true, disabled: true }, { emailVerified: false, disabled: false }]) {
      mocks.getUser.mockResolvedValueOnce(value);
      await expect(provider.verifyStaffUid('target')).rejects.toMatchObject({ code: 'STAFF_ACCOUNT_NOT_READY' });
    }
    mocks.getUser.mockResolvedValueOnce({ emailVerified: true, disabled: false });
    await expect(provider.verifyStaffUid('target')).resolves.toBeUndefined();
  });
  it('keeps deletion retries idempotent if Firebase already deleted the identity', async () => {
    const provider = createFirebaseIdentityProvider({ projectId, mode: 'firebase' }); mocks.deleteUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    await expect(provider.deleteUser('uid-1')).resolves.toBeUndefined(); mocks.deleteUser.mockRejectedValueOnce(new Error('private credentials'));
    await expect(provider.deleteUser('uid-1')).rejects.toThrow('サーバー側で再試行');
  });
});
