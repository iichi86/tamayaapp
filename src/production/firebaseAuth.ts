import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator, createUserWithEmailAndPassword,
  EmailAuthProvider, initializeAuth, onIdTokenChanged,
  reauthenticateWithCredential, reload, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import { authPersistence } from './firebasePersistence';
import type { ClientConfiguration } from './config';
import type { AuthPort, AuthSnapshot } from './ports';

function friendly(error: unknown): Error {
  const code = (error as { code?: string })?.code;
  const message = code === 'auth/invalid-email' ? 'メールアドレスを確認してください。'
    : code === 'auth/email-already-in-use' ? 'このメールアドレスでは登録できません。ログインまたはパスワードの再設定をお試しください。'
    : code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements' ? 'パスワードは12文字以上で、推測されにくいものを設定してください。'
    : code === 'auth/too-many-requests' ? '操作が続いたため一時的に制限されています。少し時間をおいてください。'
    : code === 'auth/network-request-failed' ? '通信できません。インターネット接続を確認してください。'
    : code === 'auth/requires-recent-login' ? '安全のため、もう一度ログインしてください。'
    : '操作を完了できません。メールアドレスとパスワード、通信状態を確認してください。';
  return new Error(message);
}

export function createFirebaseAuth(config: ClientConfiguration): AuthPort {
  const app = initializeApp(config.firebase, `tamaya-${config.mode}`);
  const auth = initializeAuth(app, { persistence: authPersistence() });
  auth.languageCode = 'ja';
  if (config.authEmulatorUrl) connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
  let snapshot: AuthSnapshot = { loading: true, user: null };
  const listeners = new Set<() => void>();
  const publish = () => {
    const user = auth.currentUser;
    snapshot = { loading: false, user: user ? { uid: user.uid, email: user.email, emailVerified: user.emailVerified } : null };
    listeners.forEach((listener) => listener());
  };
  onIdTokenChanged(auth, publish, () => { snapshot = { loading: false, user: null }; listeners.forEach((fn) => fn()); });
  const attempt = async (fn: () => Promise<unknown>): Promise<void> => { try { await fn(); } catch (error) { throw friendly(error); } };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    signIn: (email, password) => attempt(async () => { await signInWithEmailAndPassword(auth, email.trim(), password); await reload(auth.currentUser!); publish(); }),
    signUp: (email, password) => attempt(async () => {
      if (password.length < 12) throw { code: 'auth/weak-password' };
      await createUserWithEmailAndPassword(auth, email.trim(), password);
      publish();
    }),
    sendVerification: () => attempt(async () => { if (!auth.currentUser) throw new Error(); await sendEmailVerification(auth.currentUser); }),
    resetPassword: async (email) => {
      try { await sendPasswordResetEmail(auth, email.trim()); }
      catch (error) {
        // Avoid revealing whether an email address is registered.
        if ((error as { code?: string }).code !== 'auth/user-not-found') throw friendly(error);
      }
    },
    reloadUser: () => attempt(async () => { if (auth.currentUser) { await reload(auth.currentUser); await auth.currentUser.getIdToken(true); } publish(); }),
    signOut: () => attempt(async () => { await signOut(auth); publish(); }),
    reauthenticate: (password) => attempt(async () => {
      const user = auth.currentUser;
      if (!user?.email) throw new Error();
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      await user.getIdToken(true); publish();
    }),
    getIdToken: async (forceRefresh = false) => auth.currentUser ? auth.currentUser.getIdToken(forceRefresh) : null,
  };
}
