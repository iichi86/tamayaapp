#!/usr/bin/env node
/** Disposable local integration environment. This never connects to Firebase/Supabase accounts. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(root, 'server');
const localRoot = resolve(root, 'local-data');
const projectId = 'demo-tamaya-production';
const container = `tamaya-production-e2e-${process.pid}`;
const databaseUrl = 'postgresql://tamaya_local:local-validation-only@127.0.0.1:54330/tamaya_local';
const noWeb = process.argv.includes('--no-web');
const children = new Set();
let stopping = false;
let dockerStarted = false;
let failure;
let finish;
const finished = new Promise((resolveFinished) => { finish = resolveFinished; });

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function command(executable, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectCommand);
    child.once('exit', (code) => {
      if (code === 0) resolveCommand(stdout.trim());
      else rejectCommand(new Error(`${executable} が終了しました（${code ?? 'signal'}）。${stderr.trim().slice(0, 300)}`));
    });
  });
}

function background(name, args, env, cwd = root) {
  const child = spawn(process.execPath, args, {
    cwd, env, stdio: 'inherit', windowsHide: true,
    // Each group is ours. We never kill unrelated processes using the same port.
    detached: process.platform !== 'win32',
  });
  children.add(child);
  const failed = (message) => {
    children.delete(child);
    if (!stopping) {
      failure = new Error(message);
      finish();
    }
  };
  child.once('error', () => failed(`${name}を起動できませんでした。依存ライブラリを確認してください。`));
  child.once('exit', (code, signal) => failed(`${name}が終了しました（${code ?? signal ?? '不明'}）。直前の表示を確認してください。`));
  return child;
}

async function assertFree(port) {
  await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', () => rejectPort(new Error(`ポート${port}が使われています。前回のローカル検証をCtrl+Cで終了してから再実行してください。`)));
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}

function checkRunning() {
  if (failure) throw failure;
  if (stopping) throw new Error('ローカル検証を終了します。');
}

async function waitFor(label, check, timeout = 120_000) {
  const started = Date.now();
  let nextProgress = Date.now() + 10_000;
  while (Date.now() - started < timeout) {
    checkRunning();
    try { if (await check()) return; } catch { /* Wait for this owned process to become ready. */ }
    if (Date.now() >= nextProgress) {
      console.log(`${label}の準備を待っています…`);
      nextProgress = Date.now() + 10_000;
    }
    await sleep(400);
  }
  throw new Error(`${label}の起動が時間内に完了しませんでした。直前の表示を確認してください。`);
}

async function waitForHttp(label, url) {
  await waitFor(label, async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  });
}

async function cleanup() {
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        await command('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch { /* The owned child may already have stopped. */ }
  }
  // Firebase CLI needs time to close its hub and sockets before its parent exits.
  const until = Date.now() + 5000;
  while (children.size && Date.now() < until) await sleep(100);
  for (const child of children) {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); }
    catch { /* Already stopped. */ }
  }
  if (dockerStarted) {
    try { await command('docker', ['stop', '--time', '3', container]); }
    catch { console.error(`ローカル検証コンテナ ${container} の終了を確認してください。`); }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log('\nローカル検証を終了しています…');
    stopping = true;
    finish();
  });
}

async function main() {
  const firebaseCli = resolve(root, 'tools/node_modules/firebase-tools/lib/bin/firebase.js');
  const tsxCli = resolve(serverRoot, 'node_modules/tsx/dist/cli.mjs');
  const expoCli = resolve(root, 'node_modules/expo/bin/cli');
  for (const path of [firebaseCli, tsxCli, ...(noWeb ? [] : [expoCli])]) {
    if (!existsSync(path)) throw new Error('依存ライブラリが不足しています。npm ci、npm --prefix server ci、npm --prefix tools ciを先に実行してください。');
  }
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  await command('java', ['-version']);
  const ports = [54330, 9099, 4400, 4500, 3002, ...(noWeb ? [] : [8083])];
  for (const port of ports) await assertFree(port);

  console.log('ローカル連携検証を開始します。実際のFirebase/Supabaseには接続しません。');
  console.log('この検証中の会員データは終了時に削除されます。公開・配布用ではありません。');
  console.log('PostgreSQLの検証用コンテナを準備します。初回はイメージのダウンロードが必要です。');
  await command('docker', [
    'run', '--rm', '--detach', '--name', container,
    '--publish', '127.0.0.1:54330:5432',
    '--env', 'POSTGRES_USER=tamaya_local', '--env', 'POSTGRES_PASSWORD=local-validation-only',
    '--env', 'POSTGRES_DB=tamaya_local', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=256m',
    'postgres:17-alpine',
  ]);
  dockerStarted = true;
  await waitFor('PostgreSQL', async () => {
    await command('docker', ['exec', container, 'pg_isready', '-U', 'tamaya_local', '-d', 'tamaya_local']);
    return true;
  }, 60_000);

  mkdirSync(localRoot, { recursive: true, mode: 0o700 });
  const store = JSON.parse(readFileSync(resolve(serverRoot, 'config/tamaya.json'), 'utf8'));
  store.reward = {
    ...store.reward,
    version: 'local-validation-1',
    benefit: { kind: 'item', label: '検証用特典（本番では無効）' },
    combinationRule: '試験用・他の特典と併用不可',
    operationsEnabled: true,
  };
  store.legal.termsVersion = 'local-validation-1';
  store.legal.privacyVersion = 'local-validation-1';
  store.legal.termsText = `ローカル検証専用です。架空の特典で操作を確認します。本番運用・商品交換には使えません。\n\n${store.legal.termsText}`;
  store.legal.privacyText = `ローカル検証専用です。実在するお客様の情報を入力しないでください。\n\n${store.legal.privacyText}`;
  const storePath = resolve(localRoot, 'store.local.json');
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    CI: '1', NO_COLOR: '1', FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
    XDG_CONFIG_HOME: resolve(localRoot, 'firebase-config'),
    XDG_CACHE_HOME: resolve(localRoot, 'cache'),
    FIREBASE_EMULATORS_PATH: resolve(localRoot, 'cache/firebase-emulators'),
    APP_ENV: 'local', NODE_ENV: 'development', AUTH_MODE: 'emulator',
    ALLOW_LOCAL_TEST_AUTH: '1', FIREBASE_PROJECT_ID: projectId,
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    DATABASE_URL: databaseUrl, DATABASE_MIGRATION_URL: databaseUrl,
    HOST: '127.0.0.1', PORT: '3002',
    QR_SIGNING_SECRET: randomBytes(48).toString('hex'),
    STORE_CONFIG_PATH: storePath, CORS_ORIGINS: 'http://127.0.0.1:8083,http://localhost:8083',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3002',
    // Do not load any real local production credential files in validation processes.
    ENV_FILE: resolve(localRoot, 'unused.env'),
  };
  // Public Firebase emulator configuration only. No DB URL or signing secret goes to Expo.
  const appEnv = {
    ...process.env,
    CI: '1', NODE_ENV: 'development', NO_COLOR: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_APP_MODE: 'local', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3002',
    EXPO_PUBLIC_STORE_ID: 'tamaya',
    EXPO_PUBLIC_FIREBASE_API_KEY: 'local-validation-not-a-real-key',
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    EXPO_PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:localvalidation',
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
    EXPO_NO_DOTENV: '1',
    __UNSAFE_EXPO_HOME_DIRECTORY: resolve(root, '.expo-user'),
  };
  background('Firebase Authenticationエミュレーター', [
    firebaseCli, 'emulators:start', '--only', 'auth', '--project', projectId,
    '--config', resolve(root, 'firebase.local.json'), '--non-interactive',
  ], env);
  await waitForHttp('Firebase Authentication', `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`);
  console.log('会員データベースのテーブルを準備します。');
  await command(process.execPath, [tsxCli, resolve(serverRoot, 'src/production/migrate.ts')], { cwd: serverRoot, env, inherit: true });
  background('会員サービスAPI', [tsxCli, resolve(serverRoot, 'src/production/index.ts')], env, serverRoot);
  await waitForHttp('会員サービスAPI', 'http://127.0.0.1:3002/health');
  if (!noWeb) {
    background('Expoブラウザプレビュー', [expoCli, 'start', '--web', '--localhost', '--port', '8083'], appEnv);
    // Expo --localhost may bind ::1. Use its advertised host rather than an IPv4-only URL.
    await waitForHttp('Expoブラウザプレビュー', 'http://localhost:8083');
  }
  console.log(`TAMAYA_LOCAL_READY ${noWeb ? 'http://127.0.0.1:3002' : 'http://localhost:8083'}`);
  console.log('終了はこの画面で Ctrl + C。検証専用データベースも終了・削除します。');
  await finished;
  if (failure) throw failure;
}

try {
  await main();
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : 'ローカル連携検証を起動できませんでした。');
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
