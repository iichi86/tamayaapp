import type { ExpoConfig } from 'expo/config';
import config from './app.json';

export default (): ExpoConfig => {
  const base = config.expo as ExpoConfig;
  const productionBuild = process.env.EAS_BUILD_PROFILE === 'production';
  if (productionBuild && (process.env.EXPO_PUBLIC_APP_MODE !== 'production' || !process.env.EXPO_IOS_BUNDLE_IDENTIFIER)) {
    throw new Error('本番の接続設定とiOS Bundle Identifierが未設定です。npm run production:checkを実行してください。');
  }
  return {
    ...base,
    icon: './assets/app-icon.png',
    ios: { ...base.ios, bundleIdentifier: process.env.EXPO_IOS_BUNDLE_IDENTIFIER ?? config.expo.ios.bundleIdentifier,
      config: { usesNonExemptEncryption: false } },
    extra: { ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}) },
  };
};
