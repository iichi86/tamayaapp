import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const child = spawn(process.execPath, [require.resolve('expo/bin/cli'), 'start', ...args.filter((arg) => arg !== '--demo')], {
  stdio: 'inherit', env: { ...process.env, ...(demo ? { EXPO_PUBLIC_APP_MODE: 'demo' } : {}) },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
