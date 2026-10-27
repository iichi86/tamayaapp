import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const name = `tamaya-db-check-${process.pid}`;
const child = (cmd, args, env = process.env, inherited = false) => new Promise((resolve, reject) => {
  const proc = spawn(cmd, args, { stdio: inherited ? 'inherit' : ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  let output = ''; proc.stdout?.on('data', (data) => { output += data; });
  proc.once('error', reject); proc.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`検証コマンドが終了しました（${code}）。Dockerと依存ライブラリを確認してください。`)));
});
let started = false;
try {
  await child('docker', ['run', '--detach', '--rm', '--name', name, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=tamaya_check', '-e', 'POSTGRES_PASSWORD=local-validation-only', '-e', 'POSTGRES_DB=tamaya_check',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=256m', 'postgres:17-alpine']);
  started = true;
  const port = (await child('docker', ['port', name, '5432/tcp'])).split(':').at(-1);
  for (let i = 0; i < 100; i++) {
    try { await child('docker', ['exec', name, 'pg_isready', '-U', 'tamaya_check']); break; }
    catch { if (i === 99) throw new Error('検証用DBを準備できませんでした。'); await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  await child(process.execPath, [require.resolve('../server/node_modules/vitest/vitest.mjs'), 'run', '--root', 'server'], {
    ...process.env, TEST_DATABASE_URL: `postgres://tamaya_check:local-validation-only@127.0.0.1:${port}/tamaya_check`,
  }, true);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (started) await child('docker', ['stop', '--time', '3', name]).catch(() => undefined); }
