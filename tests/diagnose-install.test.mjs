import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectInstallDiagnostics, readInstallLog, summarizeInstallLog } from '../scripts/diagnose-install.mjs';

const tarball = 'https://registry.npmjs.org/example-package/-/example-package-1.2.3.tgz';
const scopedTarball = 'https://registry.npmjs.org/@example/widget/-/widget-2.3.4.tgz';
const lockfile = { packages: {
  '': { name: 'tamaya-members-demo' },
  'node_modules/example-package': { version: '1.2.3', resolved: tarball },
  'node_modules/@example/widget': { version: '2.3.4', resolved: scopedTarball },
} };

test('reports a package only for an explicitly failed download matching the lockfile', () => {
  const summary = summarizeInstallLog(`1 verbose title npm ci\n2 http fetch GET ${tarball} attempt 3 failed with ECONNRESET\n3 error code ECONNRESET`, lockfile);
  assert.deepEqual(summary.failedPackages, ['example-package@1.2.3']);
  assert.deepEqual(summary.errorCodes, ['ECONNRESET']);
});

test('recognizes a failed scoped package without printing the URL or untrusted error detail', () => {
  const secret = 'PRIVATE-TOKEN-DO-NOT-PRINT';
  const summary = summarizeInstallLog(`1 verbose title npm install\n2 verbose stack FetchError: request to ${scopedTarball} failed, reason: read ECONNRESET ${secret}\n3 error code ECONNRESET`, lockfile);
  assert.deepEqual(summary.failedPackages, ['@example/widget@2.3.4']);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('https://'), false);
});

test('a later successful HTTP response clears the earlier failed attempt for the same URL', () => {
  const summary = summarizeInstallLog(`1 http fetch GET ${tarball} attempt 1 failed with ECONNRESET\n2 http fetch GET 200 ${tarball} 20ms (cache miss)\n3 error code ECONNRESET`, lockfile);
  assert.deepEqual(summary.failedPackages, []);
  assert.deepEqual(summary.errorCodes, ['ECONNRESET']);
});

test('does not infer the failed package from the last successful fetch', () => {
  const summary = summarizeInstallLog(`1 http fetch GET 200 ${tarball} 20ms (cache miss)\n2 error code ECONNRESET\n3 verbose stack read ECONNRESET`, lockfile);
  assert.deepEqual(summary.failedPackages, []);
});

test('recognizes explicit HTTP failure and clears it after a 304 response', () => {
  const failed = summarizeInstallLog(`1 http fetch GET 503 ${tarball} 30ms\n2 error code ECONNRESET`, lockfile);
  assert.deepEqual(failed.failedPackages, ['example-package@1.2.3']);
  const recovered = summarizeInstallLog(`1 http fetch GET 503 ${tarball} 30ms\n2 http fetch GET 304 ${tarball} 10ms`, lockfile);
  assert.deepEqual(recovered.failedPackages, []);
});

test('rejects authenticated, query-bearing, fragment-bearing, private-host and unknown URLs', () => {
  const urls = [
    tarball.replace('https://', 'https://private-user:PRIVATE-PASSWORD@'),
    `${tarball}?token=PRIVATE-TOKEN`, `${tarball}#PRIVATE-TOKEN`,
    tarball.replace('registry.npmjs.org', 'private.example'),
    'https://registry.npmjs.org/unknown/-/unknown-1.0.0.tgz',
  ];
  for (const url of urls) {
    const summary = summarizeInstallLog(`1 http fetch GET ${url} attempt 3 failed with ECONNRESET\n2 error code ECONNRESET`, lockfile);
    assert.deepEqual(summary.failedPackages, []);
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(summary).includes('private.example'), false);
  }
});

test('rejects lockfile package labels and versions containing untrusted text', () => {
  const invalid = { packages: {
    'node_modules/bad\nPRIVATE-TOKEN': { version: '1.0.0', resolved: tarball },
    'node_modules/@example/widget': { version: 'PRIVATE token\nVALUE', resolved: scopedTarball },
  } };
  const summary = summarizeInstallLog(`1 http fetch GET ${tarball} attempt 1 failed with ECONNRESET\n2 http fetch GET ${scopedTarball} attempt 1 failed with ECONNRESET`, invalid);
  assert.deepEqual(summary.failedPackages, []);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});

test('separates a cleanup warning from the final installation error', () => {
  const summary = summarizeInstallLog("1 warn cleanup [Error: ENOTEMPTY: directory not empty, rmdir 'C:\\Users\\PRIVATE\\node_modules']\n2 warn cleanup { code: 'ENOTEMPTY' }\n3 error code ECONNRESET", lockfile);
  assert.deepEqual(summary.errorCodes, ['ECONNRESET']);
  assert.deepEqual(summary.cleanupCodes, ['ENOTEMPTY']);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});

test('unknown final error codes and malformed lockfiles never leak arbitrary log text', () => {
  for (const lock of [null, {}, { packages: null }]) {
    const summary = summarizeInstallLog('1 error code PRIVATE-TOKEN\n2 verbose stack password=PRIVATE-PASSWORD', lock);
    assert.deepEqual(summary.errorCodes, []);
    assert.deepEqual(summary.failedPackages, []);
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  }
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tamaya-log-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const filename = (millisecond) => `2026-10-31T04_07_54_${String(millisecond).padStart(3, '0')}Z-debug-0.log`;

test('selects the newest installation log while skipping newer ping and config logs', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, filename(1)), '1 verbose title npm ci\n2 error code ECONNRESET');
  await writeFile(join(directory, filename(2)), '1 verbose title npm ping\n2 notice PONG');
  await writeFile(join(directory, filename(3)), '1 verbose title npm config get proxy\n2 PRIVATE-PROXY-PASSWORD');
  const result = await readInstallLog(directory, lockfile);
  assert.equal(result.status, 'found');
  assert.equal(result.name, filename(1));
  assert.deepEqual(result.summary.errorCodes, ['ECONNRESET']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('accepts npm install headers as well as npm ci', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, filename(1)), '8 verbose title npm install --prefer-offline\n9 error code EINTEGRITY');
  const result = await readInstallLog(directory, lockfile);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.summary.errorCodes, ['EINTEGRITY']);
});

test('ignores arbitrary filenames rather than exposing them as a diagnostic', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'PRIVATE-PASSWORD-debug-0.log'), '1 verbose title npm ci\n2 error code ECONNRESET');
  const result = await readInstallLog(directory, lockfile);
  assert.equal(result.status, 'not_found');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('handles an empty or unavailable log directory using static status values', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.equal((await readInstallLog(directory, lockfile)).status, 'not_found');
  assert.equal((await readInstallLog(join(directory, 'PRIVATE-MISSING'), lockfile)).status, 'unavailable');
});

test('reads a bounded header and tail for a large log instead of losing the final error', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, filename(1)), `1 verbose title npm ci\n${'2 silly work in progress\n'.repeat(300)}3 http fetch GET ${tarball} attempt 3 failed with ECONNRESET\n4 error code ECONNRESET`);
  const result = await readInstallLog(directory, lockfile, { maxBytes: 1024 });
  assert.equal(result.status, 'found');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.summary.errorCodes, ['ECONNRESET']);
  assert.deepEqual(result.summary.failedPackages, ['example-package@1.2.3']);
});

test('honors a lower scan bound and caps the maximum number of candidate logs at 100', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, filename(0)), '1 verbose title npm ci\n2 error code ECONNRESET');
  await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(directory, filename(index + 1)), '1 verbose title npm ping\n2 notice PONG')));
  assert.equal((await readInstallLog(directory, lockfile, { maxLogs: 2 })).status, 'not_found');
  assert.equal((await readInstallLog(directory, lockfile, { maxLogs: 1000 })).status, 'not_found');
});

test('does not follow a log symlink outside the diagnostics directory', async (t) => {
  const directory = await temporaryDirectory(t);
  const logDirectory = join(directory, 'logs');
  await mkdir(logDirectory);
  const target = join(directory, 'PRIVATE-OUTSIDE.log');
  await writeFile(target, '1 verbose title npm ci\n2 error code ECONNRESET');
  try { await symlink(target, join(logDirectory, filename(1))); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Local account cannot create symlinks'); return; }
    throw error;
  }
  assert.equal((await readInstallLog(logDirectory, lockfile)).status, 'not_found');
});

test('collects only safe enums for npm configuration and cache presence without exposing private values', async (t) => {
  const directory = await temporaryDirectory(t);
  const userProfile = join(directory, 'PRIVATE-USER-PATH');
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lockfile));
  await writeFile(join(directory, '.env'), 'SECRET=PRIVATE-ENV-VALUE');
  await mkdir(join(directory, '.npm-cache', '_logs'), { recursive: true });
  await writeFile(join(directory, '.npm-cache', '_logs', filename(1)), '1 verbose title npm ci\n2 error code ECONNRESET');
  await mkdir(join(directory, 'server', '.npm-cache', '_cacache'), { recursive: true });
  await mkdir(join(userProfile, 'Downloads', 'tamayaapp-main', '.npm-cache', '_cacache'), { recursive: true });
  const env = { USERPROFILE: userProfile, HTTPS_PROXY: 'https://PRIVATE-USER:PRIVATE-PASSWORD@private.proxy.example/' };
  const runNpm = async (args) => args[0] === '--version' ? 'PRIVATE-VERSION-TEXT'
    : args.at(-1) === 'registry' ? 'https://PRIVATE-USER:PRIVATE-PASSWORD@registry.npmjs.org/'
      : 'https://PRIVATE-USER:PRIVATE-PASSWORD@private.proxy.example/';
  const report = await collectInstallDiagnostics({ directory, runNpm, env });
  assert.equal(report.LOCKFILE, 'ok');
  assert.equal(report.NPM_VERSION, 'unknown');
  assert.equal(report.NPM_PROXY_CONFIGURED, 'yes');
  assert.equal(report.NPM_HTTPS_PROXY_CONFIGURED, 'yes');
  assert.equal(report.NPM_REGISTRY, 'other');
  assert.equal(report.ENV_PROXY_CONFIGURED, 'yes');
  assert.equal(report.SERVER_CACHE, 'found');
  assert.equal(report.OLD_PROJECT_CACHE, 'found');
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(report).includes('https://'), false);
  const official = await collectInstallDiagnostics({ directory, env: {}, runNpm: async (args) =>
    args[0] === '--version' ? '11.19.1' : args.at(-1) === 'registry' ? 'https://registry.npmjs.org/' : 'null' });
  assert.equal(official.NPM_REGISTRY, 'official');
  assert.equal(official.NPM_PROXY_CONFIGURED, 'no');
  assert.equal(official.NPM_VERSION, '11.19.1');
});

test('does not invoke npm configuration commands when the project lockfile is missing', async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const report = await collectInstallDiagnostics({ directory, env: {}, runNpm: async () => { calls++; return 'PRIVATE'; } });
  assert.equal(report.LOCKFILE, 'missing_or_invalid');
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});
