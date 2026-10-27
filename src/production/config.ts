export interface ClientConfiguration {
  mode: 'production' | 'local'; apiUrl: string; storeId: string;
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string };
  authEmulatorUrl?: string;
}

/** Expo only inlines literal EXPO_PUBLIC references. Never put database keys here. */
export function clientConfiguration(): ClientConfiguration {
  const mode = process.env.EXPO_PUBLIC_APP_MODE === 'local' ? 'local' : 'production';
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';
  const firebase = {
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',
  };
  if (!apiUrl || Object.values(firebase).some((value) => !value)) {
    throw new Error('本番の接続設定が未完了です。管理者がFirebaseと管理サーバーの設定を行ってください。端末内デモを試す場合は「npm run start:demo」を使います。');
  }
  const api = new URL(apiUrl);
  const emulator = process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL;
  if (mode === 'production') {
    if (api.protocol !== 'https:' || emulator || firebase.projectId.startsWith('demo-')) {
      throw new Error('本番アプリにはHTTPSの管理サーバーと本番Firebase設定が必要です。検証用認証では起動しません。');
    }
  } else {
    const isDevelopment = typeof __DEV__ !== 'undefined' && __DEV__;
    const emu = emulator ? new URL(emulator) : null;
    if (!isDevelopment || !firebase.projectId.startsWith('demo-') || !emu
      || !['localhost', '127.0.0.1', '[::1]'].includes(emu.hostname)
      || !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) {
      throw new Error('ローカル認証は開発中の同じPC内だけで使用できます。');
    }
  }
  return { mode, apiUrl, firebase, storeId: process.env.EXPO_PUBLIC_STORE_ID ?? 'tamaya', authEmulatorUrl: emulator };
}
