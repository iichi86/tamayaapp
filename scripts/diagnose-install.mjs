import { spawnSync } from 'node:child_process';
import { access, lstat, open, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOGS = 100;
const LOG_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z-debug-\d+\.log$/;
const INSTALL_TITLE = /^\d+\s+verbose\s+title\s+npm\s+(?:ci|install)(?:\s|$)/m;
const NETWORK_CODES = /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_SOCKET_TIMEOUT|FETCH_ERROR)\b/;
const ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EUSAGE', 'EINTEGRITY', 'ENOSPC', 'EACCES', 'EPERM', 'ENOTEMPTY', 'ETARGET', 'ENOTCACHED', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
const CLEANUP_CODES = new Set(['ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

function publicRegistryUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function packageLookup(lockfile) {
  const lookup = new Map();
  if (!lockfile?.packages || typeof lockfile.packages !== 'object') return lookup;
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!path.includes('node_modules/') || !entry || typeof entry !== 'object') continue;
    const url = publicRegistryUrl(entry.resolved);
    const name = typeof entry.name === 'string' ? entry.name : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = entry.version;
    if (!url || typeof name !== 'string' || name.length > 214
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
      || typeof version !== 'string' || version.length > 128
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) continue;
    lookup.set(url, name + '@' + version);
  }
  return lookup;
}

/** Summarize only allowlisted metadata. Never return a URL or raw log text. */
export function summarizeInstallLog(logText, lockfile) {
  const lookup = packageLookup(lockfile);
  const errors = new Set();
  const cleanup = new Set();
  const failed = new Map();
  for (const line of (typeof logText === 'string' ? logText : '').split(/\r?\n/)) {
    const code = line.match(/^\d+\s+error\s+code\s+([A-Z0-9_]+)\b/);
    if (code && ERROR_CODES.has(code[1])) errors.add(code[1]);
    if (/\bwarn\s+cleanup\b/.test(line)) {
      for (const candidate of CLEANUP_CODES) if (new RegExp('\\b' + candidate + '\\b').test(line)) cleanup.add(candidate);
    }
    const isHttp = /\bhttp\s+fetch\s+(?:GET|POST|PUT|HEAD)\b/i.test(line);
    const failedHttpStatus = /\bhttp\s+fetch\s+(?:GET|POST|PUT|HEAD)\s+[45]\d{2}\s+https?:\/\//i.test(line);
    const explicitFailure = (isHttp || /\bFetchError\b/.test(line)) && (NETWORK_CODES.test(line) || failedHttpStatus);
    const success = isHttp && /\bhttp\s+fetch\s+(?:GET|POST|PUT|HEAD)\s+(?:2\d{2}|304)\s+https?:\/\//i.test(line);
    if (!explicitFailure && !success) continue;
    for (const candidate of line.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
      const url = publicRegistryUrl(candidate.replace(/[),.;]+$/, ''));
      if (!url || !lookup.has(url)) continue;
      if (explicitFailure) failed.set(url, lookup.get(url));
      else if (success) failed.delete(url);
    }
  }
  return { errorCodes: [...errors].sort(), cleanupCodes: [...cleanup].sort(), failedPackages: [...new Set(failed.values())].sort() };
}

async function readChunk(file, length, position) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const part = await file.read(buffer, total, length - total, position + total);
    if (!part.bytesRead) break;
    total += part.bytesRead;
  }
  return buffer.subarray(0, total);
}

/** Read no more than 2 MiB per log and inspect no more than 100 named logs. */
export async function readInstallLog(logDirectory, lockfile, options = {}) {
  const maxLogs = Number.isInteger(options.maxLogs) && options.maxLogs > 0 ? Math.min(options.maxLogs, MAX_LOGS) : MAX_LOGS;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes >= 1024 ? Math.min(options.maxBytes, MAX_LOG_BYTES) : MAX_LOG_BYTES;
  let names;
  try { names = (await readdir(logDirectory)).filter((name) => LOG_NAME.test(name)).sort().reverse().slice(0, maxLogs); }
  catch { return { status: 'unavailable' }; }
  for (const name of names) {
    let file;
    try {
      const path = join(logDirectory, name);
      const metadata = await lstat(path);
      if (!metadata.isFile()) continue; // Do not follow log symlinks.
      file = await open(path, 'r');
      const headerBytes = Math.min(metadata.size, 4096, Math.floor(maxBytes / 4));
      const header = await readChunk(file, headerBytes, 0);
      if (!INSTALL_TITLE.test(header.toString('utf8'))) continue;
      let contents = header;
      const truncated = metadata.size > maxBytes;
      if (metadata.size > headerBytes) {
        const tailBytes = Math.min(metadata.size - headerBytes, maxBytes - headerBytes);
        const position = truncated ? metadata.size - tailBytes : headerBytes;
        const tail = await readChunk(file, tailBytes, position);
        contents = Buffer.concat(truncated ? [header, Buffer.from('\n'), tail] : [header, tail]);
      }
      return { status: 'found', name, summary: summarizeInstallLog(contents.toString('utf8'), lockfile), truncated };
    } catch { /* A log may disappear; try the next named log without exposing its path. */ }
    finally { if (file) await file.close().catch(() => undefined); }
  }
  return { status: 'not_found' };
}

function defaultRunNpm(args) {
  try {
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ' + args.join(' ')], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true })
      : spawnSync('npm', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : null;
  } catch { return null; }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function configured(value) {
  if (value === null || value === undefined) return 'unknown';
  return !value || value === 'null' || value === 'undefined' ? 'no' : 'yes';
}

/** Local read-only diagnostics. No registry requests, package installs or config writes. */
export async function collectInstallDiagnostics(options = {}) {
  const directory = resolve(options.directory ?? '.');
  const env = options.env ?? process.env;
  const runNpm = options.runNpm ?? defaultRunNpm;
  const report = {
    NODE_VERSION: process.version,
    PLATFORM: process.platform,
    ARCH: process.arch,
    LOCKFILE: 'invalid',
  };
  let lockfile;
  try {
    const file = await open(join(directory, 'package-lock.json'), 'r');
    try {
      const metadata = await file.stat();
      if (metadata.size > 8 * 1024 * 1024) return report;
      lockfile = JSON.parse((await readChunk(file, metadata.size, 0)).toString('utf8'));
    } finally { await file.close(); }
    if (!lockfile?.packages || typeof lockfile.packages !== 'object') return report;
    report.LOCKFILE = 'ok';
  } catch { report.LOCKFILE = 'missing_or_invalid'; return report; }

  const install = await readInstallLog(join(directory, '.npm-cache', '_logs'), lockfile);
  report.INSTALL_LOG = install.status === 'found' ? install.name : install.status;
  report.LOG_TRUNCATED = install.truncated ? 'yes' : 'no';
  report.INSTALL_ERROR_CODES = install.summary?.errorCodes.join(',') || 'not_identified';
  report.CLEANUP_WARNING_CODES = install.summary?.cleanupCodes.join(',') || 'none_identified';
  report.FAILED_DOWNLOAD_PACKAGES = install.summary?.failedPackages.slice(0, 20).join(',') || 'not_identified';
  report.FAILED_DOWNLOAD_PACKAGE_COUNT = String(install.summary?.failedPackages.length ?? 0);
  try { await access(join(directory, 'node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo')); report.EXPO_LAUNCHER = 'found'; }
  catch { report.EXPO_LAUNCHER = 'missing'; }

  const version = await runNpm(['--version']);
  report.NPM_VERSION = typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : 'unknown';
  report.NPM_PROXY_CONFIGURED = configured(await runNpm(['config', 'get', 'proxy']));
  report.NPM_HTTPS_PROXY_CONFIGURED = configured(await runNpm(['config', 'get', 'https-proxy']));
  const registry = await runNpm(['config', 'get', 'registry']);
  try {
    const value = new URL(registry);
    report.NPM_REGISTRY = value.protocol === 'https:' && value.hostname === 'registry.npmjs.org' && !value.port && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash ? 'official' : 'other';
  } catch { report.NPM_REGISTRY = 'unknown'; }
  report.ENV_PROXY_CONFIGURED = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some((key) => typeof env[key] === 'string' && env[key].trim()) ? 'yes' : 'no';
  report.SERVER_CACHE = await isDirectory(join(directory, 'server', '.npm-cache', '_cacache')) ? 'found' : 'missing';
  report.OLD_PROJECT_CACHE = 'unknown';
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE) {
    const previous = join(env.USERPROFILE, 'Downloads', 'tamayaapp-main');
    report.OLD_PROJECT_CACHE = await isDirectory(join(previous, '.npm-cache', '_cacache'))
      || await isDirectory(join(previous, 'tamayaapp-main', '.npm-cache', '_cacache')) ? 'found' : 'missing';
  }
  return report;
}

export function printInstallDiagnostics(report) {
  console.log('TAMAYA_INSTALL_DIAGNOSTICS_BEGIN');
  for (const [key, value] of Object.entries(report)) console.log(key + '=' + value);
  console.log('TAMAYA_INSTALL_DIAGNOSTICS_END');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  collectInstallDiagnostics().then(printInstallDiagnostics).catch(() => {
    printInstallDiagnostics({ DIAGNOSTIC_STATUS: 'unavailable' });
    process.exitCode = 1;
  });
}
