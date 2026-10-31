import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { reuseInstallCache } from '../scripts/reuse-install-cache.mjs';

const bytes = Buffer.from('Verified public-only package-body test fixture');
const digest = createHash('sha512').update(bytes).digest('hex');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const fixturePackage = { version: '1.2.3', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz', integrity };
const suffix = join('sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));

async function fixture(t, entry = fixturePackage) {
  const directory = await mkdtemp(join(tmpdir(), 'tamaya-reuse-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  const profile = join(directory, 'PRIVATE-USER');
  await mkdir(root);
  const lock = { name: 'tamaya-members-demo', lockfileVersion: 3, packages: {
    '': { name: 'tamaya-members-demo' }, 'node_modules/example': entry,
  } };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  const sourceBase = join(root, 'server', '.npm-cache', '_cacache', 'content-v2');
  const oldBase = join(profile, 'Downloads', 'tamayaapp-main', '.npm-cache', '_cacache', 'content-v2');
  const nestedBase = join(profile, 'Downloads', 'tamayaapp-main', 'tamayaapp-main', '.npm-cache', '_cacache', 'content-v2');
  const destinationBase = join(root, '.npm-cache', '_cacache', 'content-v2');
  return { root, profile, lock, sourceBase, oldBase, nestedBase, destinationBase,
    options: { directory: root, env: { USERPROFILE: profile }, platform: 'win32', arch: 'x64' } };
}
async function save(base, contents = bytes) {
  const path = join(base, suffix);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

test('copies only a verified locked digest from the server cache and preserves source/configuration', async (t) => {
  const f = await fixture(t);
  const source = await save(f.sourceBase);
  await writeFile(join(f.root, '.env'), 'PRIVATE-ENV-UNCHANGED');
  await writeFile(join(f.sourceBase, 'unrelated'), 'PRIVATE-UNRELATED-CACHE');
  const report = await reuseInstallCache(f.options);
  assert.equal(report.COPIED_BLOBS, 1);
  assert.equal(report.MISSING_BLOBS, 0);
  assert.deepEqual(await readFile(join(f.destinationBase, suffix)), bytes);
  assert.deepEqual(await readFile(source), bytes);
  assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'PRIVATE-ENV-UNCHANGED');
  await assert.rejects(stat(join(f.destinationBase, 'unrelated')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.root, '.npm-cache', '_cacache', 'index-v5')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(report).includes('https://'), false);
});

test('never overwrites an existing destination, even if its bytes do not match the expected digest', async (t) => {
  const f = await fixture(t);
  await save(f.sourceBase);
  const destination = await save(f.destinationBase, Buffer.from('existing bytes retained'));
  const report = await reuseInstallCache(f.options);
  assert.equal(report.EXISTING_BLOBS, 1);
  assert.equal(report.COPIED_BLOBS, 0);
  assert.equal(await readFile(destination, 'utf8'), 'existing bytes retained');
});

test('ignores corrupt source bytes and uses the valid old cache instead', async (t) => {
  const f = await fixture(t);
  const corrupt = await save(f.sourceBase, Buffer.from('corrupt source retained'));
  await save(f.oldBase);
  const report = await reuseInstallCache(f.options);
  assert.equal(report.CORRUPT_SOURCE_BLOBS, 1);
  assert.equal(report.COPIED_BLOBS, 1);
  assert.equal(report.SOURCE_CACHES, 2);
  assert.equal(await readFile(corrupt, 'utf8'), 'corrupt source retained');
  assert.deepEqual(await readFile(join(f.destinationBase, suffix)), bytes);
});

test('finds the nested old Downloads folder without printing its location', async (t) => {
  const f = await fixture(t);
  await save(f.nestedBase);
  const report = await reuseInstallCache(f.options);
  assert.equal(report.COPIED_BLOBS, 1);
  assert.equal(JSON.stringify(report).includes(f.profile), false);
});

test('reports unavailable or corrupt bodies as missing using only known package identities', async (t) => {
  const f = await fixture(t);
  await save(f.sourceBase, Buffer.from('bad'));
  const report = await reuseInstallCache(f.options);
  assert.equal(report.MISSING_BLOBS, 1);
  assert.equal(report.CORRUPT_SOURCE_BLOBS, 1);
  assert.equal(report.MISSING_PACKAGES, 'example@1.2.3');
  assert.equal(report.MISSING_PACKAGE_COUNT, 1);
  await assert.rejects(stat(join(f.destinationBase, suffix)), { code: 'ENOENT' });
});

test('a second run preserves the first cached file and does not copy again', async (t) => {
  const f = await fixture(t);
  await save(f.sourceBase);
  await reuseInstallCache(f.options);
  const report = await reuseInstallCache(f.options);
  assert.equal(report.EXISTING_BLOBS, 1);
  assert.equal(report.COPIED_BLOBS, 0);
});

for (const [label, replacement] of [
  ['an unrelated project', { projectName: 'other-project' }],
  ['a private registry', { resolved: 'https://PRIVATE-USER:PRIVATE-PASSWORD@private.example/pkg.tgz' }],
  ['an authenticated official URL', { resolved: 'https://PRIVATE-USER:PRIVATE-PASSWORD@registry.npmjs.org/pkg.tgz' }],
  ['a query-bearing URL', { resolved: 'https://registry.npmjs.org/pkg.tgz?token=PRIVATE-PASSWORD' }],
  ['a malformed integrity', { integrity: 'sha512-PRIVATE-PASSWORD' }],
  ['a non-sha512 integrity', { integrity: 'sha1-' + 'a'.repeat(28) }],
  ['an unsafe version label', { version: '1.2.3\nPRIVATE-PASSWORD' }],
]) {
  test('rejects ' + label + ' before creating cache files', async (t) => {
    const f = await fixture(t, { ...fixturePackage, ...replacement });
    if (replacement.projectName) {
      f.lock.name = replacement.projectName;
      await writeFile(join(f.root, 'package-lock.json'), JSON.stringify(f.lock));
    }
    await save(f.sourceBase);
    await assert.rejects(reuseInstallCache(f.options), (error) => error.code === 'LOCKFILE_INVALID' && !String(error).includes('PRIVATE'));
    await assert.rejects(stat(f.destinationBase), { code: 'ENOENT' });
  });
}

test('refuses a missing project lockfile using a static error', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'package-lock.json'));
  await assert.rejects(reuseInstallCache(f.options), { code: 'LOCKFILE_INVALID' });
});

test('filters unsupported OS and CPU packages, including negative restrictions', async (t) => {
  const f = await fixture(t);
  f.lock.packages['node_modules/linux-only'] = { ...fixturePackage, os: ['linux'] };
  f.lock.packages['node_modules/no-windows'] = { ...fixturePackage, os: ['!win32'] };
  f.lock.packages['node_modules/arm-only'] = { ...fixturePackage, cpu: ['arm64'] };
  f.lock.packages['node_modules/no-x64'] = { ...fixturePackage, cpu: ['!x64'] };
  await writeFile(join(f.root, 'package-lock.json'), JSON.stringify(f.lock));
  await save(f.sourceBase);
  const report = await reuseInstallCache(f.options);
  assert.equal(report.EXPECTED_BLOBS, 1);
  assert.equal(report.SKIPPED_PLATFORM_PACKAGES, 4);
  assert.equal(report.COPIED_BLOBS, 1);
});

test('deduplicates identical blobs while retaining missing package identities', async (t) => {
  const f = await fixture(t);
  f.lock.packages['node_modules/alias'] = { ...fixturePackage };
  await writeFile(join(f.root, 'package-lock.json'), JSON.stringify(f.lock));
  const report = await reuseInstallCache(f.options);
  assert.equal(report.EXPECTED_BLOBS, 1);
  assert.equal(report.MISSING_BLOBS, 1);
  assert.equal(report.MISSING_PACKAGES, 'alias@1.2.3,example@1.2.3');
});

test('does not follow a destination cache-directory symlink or write outside the project', async (t) => {
  const f = await fixture(t);
  const outside = join(f.profile, 'outside');
  await mkdir(outside, { recursive: true });
  try { await symlink(outside, join(f.root, '.npm-cache'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Local account cannot create symlinks'); return; } throw error; }
  await save(f.sourceBase);
  await assert.rejects(reuseInstallCache(f.options), { code: 'DESTINATION_UNSAFE' });
  await assert.rejects(stat(join(outside, '_cacache')), { code: 'ENOENT' });
});
