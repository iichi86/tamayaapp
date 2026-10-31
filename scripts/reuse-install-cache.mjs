import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class CacheReuseError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function platformMatches(values, target) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' && /^!?[a-z0-9_-]+$/i.test(value))) {
    throw new CacheReuseError('LOCKFILE_INVALID');
  }
  const positive = values.filter((value) => !value.startsWith('!'));
  return !values.includes('!' + target) && (!positive.length || positive.includes(target) || positive.includes('any'));
}

function planCacheReuse(lock, platform, arch) {
  if (!lock || lock.name !== 'tamaya-members-demo' || !Number.isInteger(lock.lockfileVersion)
    || lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== 'object'
    || !lock.packages[''] || lock.packages[''].name !== 'tamaya-members-demo') {
    throw new CacheReuseError('LOCKFILE_INVALID');
  }
  const plans = new Map();
  let skipped = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.includes('node_modules/') || !entry || typeof entry !== 'object' || entry.link) throw new CacheReuseError('LOCKFILE_INVALID');
    if (!platformMatches(entry.os, platform) || !platformMatches(entry.cpu, arch)) { skipped++; continue; }
    if (entry.inBundle && !entry.resolved && !entry.integrity) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    if (typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
      || typeof entry.version !== 'string' || entry.version.length > 128 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version)) {
      throw new CacheReuseError('LOCKFILE_INVALID');
    }
    try {
      const url = new URL(entry.resolved);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password
        || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw new Error('Invalid registry');
    } catch { throw new CacheReuseError('LOCKFILE_INVALID'); }
    const match = typeof entry.integrity === 'string' && entry.integrity.match(/^sha512-([A-Za-z0-9+/]{86}==)$/);
    if (!match) throw new CacheReuseError('LOCKFILE_INVALID');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== match[1]) throw new CacheReuseError('LOCKFILE_INVALID');
    const digest = bytes.toString('hex');
    if (!plans.has(digest)) plans.set(digest, { digest, labels: new Set() });
    plans.get(digest).labels.add(name + '@' + entry.version);
  }
  if (!plans.size) throw new CacheReuseError('LOCKFILE_INVALID');
  return { plans: [...plans.values()], skipped };
}

async function metadata(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function hashFile(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function safeDestinationDirectory(directory, segments) {
  let path = directory;
  for (const segment of segments) {
    path = join(path, segment);
    let info = await metadata(path);
    if (!info) {
      try { await mkdir(path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await metadata(path);
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new CacheReuseError('DESTINATION_UNSAFE');
  }
  return path;
}

/** Merge only verified, locked package bodies; never overwrite any existing cache file. */
export async function reuseInstallCache(options = {}) {
  const directory = resolve(options.directory ?? '.');
  const env = options.env ?? process.env;
  let lock;
  try {
    const path = join(directory, 'package-lock.json');
    const info = await metadata(path);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Invalid project');
    lock = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new CacheReuseError('LOCKFILE_INVALID'); }
  const { plans, skipped } = planCacheReuse(lock, options.platform ?? process.platform, options.arch ?? process.arch);
  const destinationBase = join(directory, '.npm-cache', '_cacache', 'content-v2');
  const sources = [join(directory, 'server', '.npm-cache', '_cacache', 'content-v2')];
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE) {
    const previous = join(env.USERPROFILE, 'Downloads', 'tamayaapp-main');
    sources.push(join(previous, '.npm-cache', '_cacache', 'content-v2'), join(previous, 'tamayaapp-main', '.npm-cache', '_cacache', 'content-v2'));
  }
  const usableSources = [];
  for (const source of [...new Set(sources)]) {
    if (resolve(source) === resolve(destinationBase)) continue;
    try { const info = await metadata(source); if (info?.isDirectory() && !info.isSymbolicLink()) usableSources.push(source); }
    catch { /* An unavailable old cache is not a reason to touch its configuration. */ }
  }
  const report = { EXPECTED_BLOBS: plans.length, EXISTING_BLOBS: 0, COPIED_BLOBS: 0, MISSING_BLOBS: 0,
    CORRUPT_SOURCE_BLOBS: 0, CACHE_ERRORS: 0, SOURCE_CACHES: usableSources.length, SKIPPED_PLATFORM_PACKAGES: skipped };
  const missing = new Set();
  for (const plan of plans) {
    const segments = ['sha512', plan.digest.slice(0, 2), plan.digest.slice(2, 4)];
    const filename = plan.digest.slice(4);
    const destination = join(destinationBase, ...segments, filename);
    const existing = await metadata(destination);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new CacheReuseError('DESTINATION_UNSAFE');
      report.EXISTING_BLOBS++;
      continue;
    }
    let available = false;
    for (const base of usableSources) {
      const source = join(base, ...segments, filename);
      try {
        // Never follow a file symlink, even when its name resembles a digest.
        const info = await metadata(source);
        if (!info?.isFile() || info.isSymbolicLink()) continue;
        if (await hashFile(source) !== plan.digest) { report.CORRUPT_SOURCE_BLOBS++; continue; }
        await safeDestinationDirectory(directory, ['.npm-cache', '_cacache', 'content-v2', ...segments]);
        try { await copyFile(source, destination, constants.COPYFILE_EXCL); report.COPIED_BLOBS++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; report.EXISTING_BLOBS++; }
        available = true;
        break;
      } catch (error) {
        if (error instanceof CacheReuseError) throw error;
        report.CACHE_ERRORS++;
      }
    }
    if (!available) {
      report.MISSING_BLOBS++;
      for (const label of plan.labels) missing.add(label);
    }
  }
  report.MISSING_PACKAGES = [...missing].sort().slice(0, 20).join(',') || 'none';
  report.MISSING_PACKAGE_COUNT = missing.size;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('保存済みファイルを確認しています。完了までお待ちください。');
  reuseInstallCache().then((report) => {
    console.log('TAMAYA_CACHE_REUSE_BEGIN');
    for (const [key, value] of Object.entries(report)) console.log(key + '=' + value);
    console.log('TAMAYA_CACHE_REUSE_END');
  }).catch((error) => {
    const code = error instanceof CacheReuseError ? error.code : 'CACHE_UNAVAILABLE';
    console.error('CACHE_REUSE_STATUS=' + code);
    process.exitCode = 1;
  });
}
