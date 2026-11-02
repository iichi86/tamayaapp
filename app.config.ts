import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  // EAS reads the config with Expo's dotenv loader disabled. Native loading
  // also preserves values already supplied by the EAS build environment.
  if (process.loadEnvFile) {
    try { process.loadEnvFile('.env'); } catch { /* The file is optional in EAS builds. */ }
  }
  // Expo supplies the latest app.json values after EAS saves a project link.
  const base = config as ExpoConfig;
  const productionBuild = process.env.EAS_BUILD_PROFILE === 'production';
  if (productionBuild && (process.env.EXPO_PUBLIC_APP_MODE !== 'production' || !process.env.EXPO_IOS_BUNDLE_IDENTIFIER)) {
    throw new Error('本番の接続設定とiOS Bundle Identifierが未設定です。npm run production:checkを実行してください。');
  }
  return {
    ...base,
    icon: './assets/app-icon.png',
    ios: { ...base.ios, bundleIdentifier: process.env.EXPO_IOS_BUNDLE_IDENTIFIER ?? base.ios?.bundleIdentifier,
      config: { usesNonExemptEncryption: false } },
    extra: {
      ...base.extra,
      ...(process.env.EAS_PROJECT_ID ? { eas: { ...base.extra?.eas, projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
  };
};
