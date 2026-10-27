import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { DomainError } from '../types.js';
import type { ProductionIdentity } from './types.js';

export interface IdentityProvider {
  verify(token: string, options?: { allowUnverified?: boolean }): Promise<ProductionIdentity>;
  deleteUser(uid: string): Promise<void>;
  verifyStaffUid(uid: string): Promise<void>;
}
export interface FirebaseProviderOptions {
  projectId: string;
  mode: 'firebase' | 'emulator';
  emulatorHost?: string;
  now?: () => Date;
}

export function createFirebaseIdentityProvider(options: FirebaseProviderOptions): IdentityProvider {
  const { projectId, mode } = options;
  if (mode === 'firebase' && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('本番認証ではFirebaseエミュレーターの設定を削除してください。');
  }
  if (mode === 'emulator') {
    if (!projectId.startsWith('demo-') || !options.emulatorHost
      || !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(options.emulatorHost)) {
      throw new Error('ローカル認証にはdemo-で始まるプロジェクトとループバックの認証エミュレーターが必要です。');
    }
    process.env.FIREBASE_AUTH_EMULATOR_HOST = options.emulatorHost;
  }
  const name = `tamaya-production:${mode}:${projectId}`;
  const app = getApps().find((candidate) => candidate.name === name)
    ?? initializeApp(mode === 'emulator' ? { projectId } : { projectId, credential: applicationDefault() }, name);
  const auth = getAuth(app);
  const now = options.now ?? (() => new Date());
  return {
    async verify(token, verificationOptions) {
      try {
        if (!token || token.length > 8192) throw new Error('Invalid project or token');
        const decoded = await auth.verifyIdToken(token, true);
        if (decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}`
          || typeof decoded.uid !== 'string' || !decoded.uid || decoded.uid.length > 128
          || !Number.isSafeInteger(decoded.auth_time) || decoded.auth_time > Math.floor(now().getTime() / 1000) + 60) {
          throw new Error('Invalid identity');
        }
        if (decoded.email_verified !== true && !verificationOptions?.allowUnverified) {
          throw new DomainError('EMAIL_NOT_VERIFIED', 403, 'メールアドレスの確認を完了してからログインしてください。');
        }
        return { uid: decoded.uid, projectId, emailVerified: decoded.email_verified === true, authTime: decoded.auth_time };
      } catch (error) {
        if (error instanceof DomainError && error.code === 'EMAIL_NOT_VERIFIED') throw error;
        throw new DomainError('UNAUTHENTICATED', 401, 'ログインを確認できません。もう一度ログインしてください。');
      }
    },
    async verifyStaffUid(uid) {
      try {
        const user = await auth.getUser(uid);
        if (!user.emailVerified || user.disabled) throw new Error('Not eligible');
      } catch {
        throw new DomainError('STAFF_ACCOUNT_NOT_READY', 409, '対象の会員がメール確認を済ませ、利用できるログイン情報を持っているか確認してください。');
      }
    },
    async deleteUser(uid) {
      try { await auth.deleteUser(uid); }
      catch (error) {
        if ((error as { code?: string })?.code === 'auth/user-not-found') return;
        throw new Error('ログイン情報の削除を完了できませんでした。サーバー側で再試行します。');
      }
    },
  };
}
