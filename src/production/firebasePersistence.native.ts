import * as FirebaseAuth from 'firebase/auth';
import type { Persistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

export function authPersistence(): Persistence {
  // Firebase 12's RN entry exports this function, while its common .d.ts does not.
  // Metro selects @firebase/auth's react-native export; the web build uses the .ts sibling.
  const nativeAuth = FirebaseAuth as typeof FirebaseAuth & {
    getReactNativePersistence(storage: typeof AsyncStorage): Persistence;
  };
  if (typeof nativeAuth.getReactNativePersistence !== 'function') {
    throw new Error('このビルドではログイン情報を保存できません。FirebaseのReact Native設定を確認してください。');
  }
  return nativeAuth.getReactNativePersistence(AsyncStorage);
}
