import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  verify: vi.fn(),
  getAuth: vi.fn(),
  initialize: vi.fn(),
  credential: vi.fn(),
  apps: [] as Array<{ name: string }>,
}));

vi.mock('firebase-admin/app', () => ({
  getApps: () => mock.apps,
  applicationDefault: () => mock.credential(),
  initializeApp: (options: unknown, name: string) => {
    mock.initialize(options, name);
    const app = { name }; mock.apps.push(app); return app;
  },
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: (app: unknown) => { mock.getAuth(app); return { verifyIdToken: mock.verify }; } }));

import { createDemoVerifier, createFirebaseVerifier } from '../src/auth.js';
import { createMemberQr, readMemberQr } from '../src/qr.js';

beforeEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks(); mock.apps.splice(0);
  mock.credential.mockReturnValue({ serverCredential: true });
  mock.verify.mockResolvedValue({ uid: 'firebase-user', aud: 'trusted-project', iss: 'https://securetoken.google.com/trusted-project' });
});
afterEach(() => vi.unstubAllEnvs());

describe('Firebase server token verification', () => {
  it('checks revocation and uses the trusted database project with server credentials', async () => {
    const verifier = createFirebaseVerifier();
    await expect(verifier.verify('signed-token', 'trusted-project')).resolves.toEqual({ uid: 'firebase-user', projectId: 'trusted-project' });
    expect(mock.initialize).toHaveBeenCalledWith({ projectId: 'trusted-project', credential: { serverCredential: true } }, 'tamaya-auth:trusted-project');
    expect(mock.verify).toHaveBeenCalledWith('signed-token', true);
    await verifier.verify('second-token', 'trusted-project');
    expect(mock.initialize).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong audience, issuer, revoked tokens, and SDK failures without leaking details', async () => {
    const verifier = createFirebaseVerifier();
    for (const decoded of [
      { uid: 'user', aud: 'other-project', iss: 'https://securetoken.google.com/trusted-project' },
      { uid: 'user', aud: 'trusted-project', iss: 'https://attacker.example/trusted-project' },
      { uid: '', aud: 'trusted-project', iss: 'https://securetoken.google.com/trusted-project' },
    ]) {
      mock.verify.mockResolvedValueOnce(decoded);
      await expect(verifier.verify('token', 'trusted-project')).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    }
    mock.verify.mockRejectedValueOnce(new Error('secret-key-file private-jwt'));
    await expect(verifier.verify('token', 'trusted-project')).rejects.toThrow('ログインを確認できません');
  });

  it('refuses Firebase emulator unsigned-token mode in the real verifier', () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099');
    expect(() => createFirebaseVerifier()).toThrow('FIREBASE_AUTH_EMULATOR_HOST');
  });
});

describe('explicit local demo identities and presentation scope', () => {
  it('only accepts configured sample identities in the sample Firebase project', async () => {
    const verifier = createDemoVerifier();
    await expect(verifier.verify('demo-owner', 'demo-tamaya')).resolves.toMatchObject({ uid: 'demo-owner' });
    await expect(verifier.verify('demo-owner', 'real-project')).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifier.verify('arbitrary-owner', 'demo-tamaya')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses a valid signed QR for a different store or a future server time', () => {
    const now = new Date('2026-10-27T02:00:00.000Z');
    const secret = 'test-signing-key-that-has-at-least-32-characters';
    const { qr } = createMemberQr({ storeId: 'tamaya', memberId: 'member' }, secret, now);
    expect(() => readMemberQr(qr, 'other-store', secret, now)).toThrow('会員QR');
    expect(() => readMemberQr(qr, 'tamaya', secret, new Date(now.getTime() - 1))).toThrow('会員QR');
    expect(readMemberQr(qr, 'tamaya', secret, now)).toEqual({ storeId: 'tamaya', memberId: 'member' });
  });
});
