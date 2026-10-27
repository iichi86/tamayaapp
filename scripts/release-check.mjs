import { readFileSync } from 'node:fs';
if (process.argv.includes('--build') && process.env.EAS_BUILD_PROFILE !== 'production') process.exit(0);
if (process.loadEnvFile) { try { process.loadEnvFile('.env'); } catch { /* Remote EAS variables take precedence. */ } }
const required = ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_FIREBASE_API_KEY', 'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID', 'EXPO_PUBLIC_FIREBASE_APP_ID', 'EXPO_IOS_BUNDLE_IDENTIFIER'];
const issues = required.filter((name) => !process.env[name]).map((name) => `${name} が未設定`);
if (process.env.EXPO_PUBLIC_APP_MODE !== 'production') issues.push('EXPO_PUBLIC_APP_MODE は production が必要');
if (process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.startsWith('demo-')) issues.push('検証用の認証設定は配布できません');
try { if (new URL(process.env.EXPO_PUBLIC_API_URL).protocol !== 'https:') issues.push('管理APIにはHTTPSが必要'); } catch { issues.push('管理APIのURLが未設定または無効'); }
const bundle = process.env.EXPO_IOS_BUNDLE_IDENTIFIER ?? '';
if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){2,}$/.test(bundle) || bundle.includes('demo')) issues.push('正式な一意のiOS Bundle Identifierが必要');
if (process.env.RELEASE_BUSINESS_APPROVED !== '1') issues.push('正式な運用条件・法的表示の運営者確認が必要（RELEASE_BUSINESS_APPROVED）');
const store = JSON.parse(readFileSync(new URL('../server/config/tamaya.json', import.meta.url), 'utf8'));
if (!store.reward.operationsEnabled || !store.reward.benefit || !store.reward.combinationRule) issues.push('特典内容と併用条件の確定・運用有効化が必要');
if (!store.address || !store.phone || !store.informationSource) issues.push('店舗住所・電話番号を根拠付きで確認する必要があります');
if (store.legal.termsVersion.includes('draft') || store.legal.privacyVersion.includes('draft')
  || /公開前|確認用|未確定|追記します/.test(store.legal.privacyText + store.legal.termsText)) issues.push('規約・プライバシー方針を正式版に改訂する必要があります');
if (issues.length) { console.error('配布前チェック：\n' + issues.map((issue) => `・${issue}`).join('\n')); process.exitCode = 1; }
else console.log('設定チェック成功。続けて実サービスの疎通、実機確認、Apple登録情報を確認してください。');
