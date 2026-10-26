import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { DomainError, type TokenVerifier } from './types.js';

function unauthenticated(): DomainError {
  return new DomainError('UNAUTHENTICATED', 401, 'ログインを確認できません。もう一度ログインしてください。');
}

/** No Firebase claims are used as store staff privileges. The database owns those roles. */
export function createFirebaseVerifier(): TokenVerifier {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Firebase本番認証ではFIREBASE_AUTH_EMULATOR_HOSTを設定しないでください。');
  }
  return {
    async verify(token, expectedProjectId) {
      try {
        if (!token || !expectedProjectId) throw unauthenticated();
        const name = `tamaya-auth:${expectedProjectId}`;
        const app = getApps().find((candidate) => candidate.name === name)
          ?? initializeApp({ projectId: expectedProjectId, credential: applicationDefault() }, name);
        // Revocation/disabled-account checks need server-side Application Default Credentials.
        const decoded = await getAuth(app).verifyIdToken(token, true);
        if (decoded.aud !== expectedProjectId
          || decoded.iss !== `https://securetoken.google.com/${expectedProjectId}`
          || typeof decoded.uid !== 'string' || !decoded.uid || decoded.uid.length > 128) {
          throw unauthenticated();
        }
        return { uid: decoded.uid, projectId: expectedProjectId };
      } catch {
        // Never return credential paths, upstream SDK responses, or the bearer token.
        throw unauthenticated();
      }
    },
  };
}

/** Root startup only enables this explicit test identity source in local demo mode. */
export function createDemoVerifier(): TokenVerifier {
  const users = new Set(['demo-owner', 'demo-staff', 'demo-customer', 'demo-new-customer']);
  return {
    async verify(token, expectedProjectId) {
      if (expectedProjectId !== 'demo-tamaya' || !users.has(token)) throw unauthenticated();
      return { uid: token, projectId: 'demo-tamaya' };
    },
  };
}
