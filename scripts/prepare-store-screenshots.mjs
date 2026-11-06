import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_SIZE = Object.freeze({ width: 1179, height: 2556 });
const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 100 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const require = createRequire(import.meta.url);
const messages = {
  PROJECT: '玉屋アプリのフォルダーで、Node.js 24以降を使って実行してください。',
  WINDOWS: 'この画像準備はWindowsのPCで実行してください。',
  CANCELLED: '画像の選択をキャンセルしたため終了しました。',
  PICKER: '画像を選ぶ画面を開けませんでした。表示されたエラーコードを伝えてください。',
  SELECTION: 'ホーム・お店・利用条件の画像を、重複なしで3枚選んでください。',
  IMAGE: 'PNGまたはJPEGの通常の画像ファイルを選んでください。',
  IMAGE_READ: '選択した画像を読み取れませんでした。PNGまたはJPEGの画像を選んでください。',
  SDK: '導入済みの画像処理ライブラリを読み込めません。SCREENSHOT_SDKの表示を伝えてください。',
  SHAPE: 'スマートフォンの縦長画面として確認できません。横向きの画像や、画面の一部分だけの画像が選ばれていないか確認してください。',
  CHANGED: '選択した画像が処理中に変わったため終了しました。元画像を保存し直してから再実行してください。',
  RENDER: '画像の出力を完了できませんでした。元画像は上書きしていません。',
  OUTPUT: '出力したPNGのサイズ・形式を確認できませんでした。元画像は上書きしていません。',
};
export class ScreenshotPreparationError extends Error {
  constructor(code, diagnostic = '') {
    const detail = /^[A-Za-z0-9_.:+-]{1,180}$/.test(diagnostic) ? ` (${diagnostic})` : '';
    super(`[SCREENSHOT_${code}] ${messages[code]}${detail}`); this.code = code;
  }
}
const fail = code => { throw new ScreenshotPreparationError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function fitScreenshot(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 250 || height < 500 || width * height > MAX_PIXELS
    || width >= height || width / height < 0.40 || width / height > 0.52) fail('SHAPE');
  const scale = Math.min(SCREENSHOT_SIZE.width / width, SCREENSHOT_SIZE.height / height);
  const drawWidth = Math.min(SCREENSHOT_SIZE.width, Math.max(1, Math.round(width * scale)));
  const drawHeight = Math.min(SCREENSHOT_SIZE.height, Math.max(1, Math.round(height * scale)));
  return { width, height, drawWidth, drawHeight,
    x: Math.floor((SCREENSHOT_SIZE.width - drawWidth) / 2),
    y: Math.floor((SCREENSHOT_SIZE.height - drawHeight) / 2),
    scale, upscaled: scale > 1.000001, smallSource: width < 590 || height < 1278 };
}

// PowerShell is used only for the native file dialog. Image decoding and
// rendering run in the same Node code exercised by the raster tests.
export function buildPowerShellScript(operation = 'pick') {
  if (operation !== 'pick') throw new TypeError('Only the image picker uses PowerShell.');
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = $null
$owner = $null
$phase = 'forms'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $owner = [System.Windows.Forms.Form]::new()
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = 'CenterScreen'
  $owner.Size = [System.Drawing.Size]::new(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog.Title = 'ホーム・お店・利用条件の画像を3枚選んでください'
  $dialog.Filter = 'スクリーンショット (*.png;*.jpg;*.jpeg)|*.png;*.jpg;*.jpeg'
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $true
  $dialog.InitialDirectory = [Environment]::GetFolderPath('MyPictures')
  $phase = 'dialog'
  if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) { exit 3 }
  if ($dialog.FileNames.Count -ne 3) { exit 4 }
  $phase = 'desktop'
  @{ files = @($dialog.FileNames); desktop = [Environment]::GetFolderPath('DesktopDirectory') } | ConvertTo-Json -Depth 3 -Compress
} catch {
  @{ phase = $phase; type = $_.Exception.GetType().FullName; hresult = $_.Exception.HResult } | ConvertTo-Json -Compress
  exit 5
} finally {
  if ($null -ne $dialog) { $dialog.Dispose() }
  if ($null -ne $owner) { $owner.Dispose() }
}
`;
}

export function runWindowsPowerShell({ script = buildPowerShellScript(), execute = execFileSync } = {}) {
  try {
    const stdout = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive',
      '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 65536, input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch (error) {
    if (error.status === 3) fail('CANCELLED');
    if (error.status === 4) fail('SELECTION');
    let diagnostic = '';
    try {
      const detail = JSON.parse(String(error.stdout).replace(/^\uFEFF/, '').trim());
      if (['forms', 'dialog', 'desktop'].includes(detail.phase) && typeof detail.type === 'string'
        && /^System\.[A-Za-z0-9_.]+$/.test(detail.type) && Number.isSafeInteger(detail.hresult)) {
        diagnostic = `${detail.phase}:${detail.type}:${detail.hresult}`;
      }
    } catch {}
    throw new ScreenshotPreparationError('PICKER', diagnostic);
  }
}

function libraries() {
  try {
    // Both are already in the SDK 58 project lockfile; no install or network.
    const Jimp = require('jimp-compact');
    const { PNG } = require('pngjs');
    return { Jimp, PNG };
  } catch { fail('SDK'); }
}

async function regularFile(path) {
  const info = await lstat(path).catch(() => fail('IMAGE'));
  // Node distinguishes actual symbolic links from OneDrive cloud placeholders.
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) fail('IMAGE');
  return readFile(path);
}

function imageSignature(bytes, extension) {
  if (extension === '.png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (['.jpg', '.jpeg'].includes(extension) && bytes.length >= 4
    && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  fail('IMAGE');
}

export async function renderScreenshot({ image, geometry }) {
  const { Jimp, PNG } = libraries();
  const resized = image.clone().resize(geometry.drawWidth, geometry.drawHeight, Jimp.RESIZE_BICUBIC);
  const canvas = new Jimp(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height, 0xF5F2E9FF);
  canvas.composite(resized, geometry.x, geometry.y);
  return PNG.sync.write({ width: SCREENSHOT_SIZE.width, height: SCREENSHOT_SIZE.height,
    data: canvas.bitmap.data }, { colorType: 2, inputColorType: 6, inputHasAlpha: true });
}

function validateOutput(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || imageSignature(bytes, '.png') !== 'png'
      || bytes.readUInt32BE(16) !== SCREENSHOT_SIZE.width || bytes.readUInt32BE(20) !== SCREENSHOT_SIZE.height
      || bytes[24] !== 8 || bytes[25] !== 2) fail('OUTPUT');
    const { PNG } = libraries();
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    for (let i = 3; i < decoded.data.length; i += 4) if (decoded.data[i] !== 255) fail('OUTPUT');
  } catch (error) {
    if (error instanceof ScreenshotPreparationError && error.code === 'SDK') throw error;
    fail('OUTPUT');
  }
}

function openExplorer(directory) {
  const child = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); child.unref();
}

export async function prepareStoreScreenshots({ root = process.cwd(), platform = process.platform,
  selectImages = runWindowsPowerShell, renderImage = renderScreenshot, openFolder = openExplorer,
  log = console.log, now = () => new Date(), makeId = randomUUID } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('PROJECT');
  if (platform !== 'win32') fail('WINDOWS');
  root = await realpath(resolve(root));
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
    if (pkg.name !== 'tamaya-members-demo' || app?.owner !== 'oneight'
      || app?.ios?.bundleIdentifier !== 'jp.oneeight.tamaya.members') fail('PROJECT');
  } catch { fail('PROJECT'); }
  const { Jimp } = libraries();
  log('画像選択画面が開きます。ホーム・お店・利用条件の画像を3枚選んで「開く」を押してください。');
  const selected = await selectImages();
  if (!object(selected) || !Array.isArray(selected.files) || selected.files.length !== 3) fail('SELECTION');
  if (typeof selected.desktop !== 'string' || !isAbsolute(selected.desktop)) fail('OUTPUT');
  const desktop = resolve(selected.desktop);
  const desktopInfo = await lstat(desktop).catch(() => fail('OUTPUT'));
  if (!desktopInfo.isDirectory() || desktopInfo.isSymbolicLink()) fail('OUTPUT');
  const seen = new Set();
  const plans = [];
  for (const [index, source] of selected.files.entries()) {
    if (typeof source !== 'string' || !isAbsolute(source) || /[\u0000-\u001f]/.test(source)) fail('IMAGE');
    const path = resolve(source);
    if (seen.has(path.toLowerCase())) fail('SELECTION');
    seen.add(path.toLowerCase());
    const bytes = await regularFile(path);
    const format = imageSignature(bytes, extname(path).toLowerCase());
    if (format === 'png') fitScreenshot(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let image;
    try { image = await Jimp.read(bytes); } catch { fail('IMAGE_READ'); }
    const geometry = fitScreenshot(image.bitmap.width, image.bitmap.height);
    const stem = basename(path, extname(path)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'screenshot';
    plans.push({ path, sha256: hash(bytes), image, geometry,
      outputName: `${String(index + 1).padStart(2, '0')}-${stem}.png` });
    log(`${index + 1}枚目：${geometry.width} × ${geometry.height}px → 1179 × 2556px${geometry.upscaled ? '（拡大）' : ''}`);
    if (geometry.smallSource) log('元画像が小さいため、拡大しても細部の画質は戻りません。出力後の文字の見え方を確認してください。');
  }
  const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = makeId().replace(/-/g, '').slice(0, 12);
  if (!/^\d{8}-\d{6}$/.test(stamp) || !/^[a-f0-9]{12}$/.test(id)) fail('OUTPUT');
  const folderName = `Tamaya-AppStore-${stamp}-${id}`;
  const prepared = [];
  for (const plan of plans) {
    let bytes;
    try { bytes = await renderImage({ image: plan.image, geometry: plan.geometry }); }
    catch (error) { if (error instanceof ScreenshotPreparationError) throw error; fail('RENDER'); }
    validateOutput(bytes);
    prepared.push(bytes);
  }
  for (const plan of plans) if (hash(await regularFile(plan.path)) !== plan.sha256) fail('CHANGED');
  const directory = join(desktop, folderName);
  try { await mkdir(directory); } catch { fail('OUTPUT'); }
  const outputs = [];
  try {
    for (const [index, plan] of plans.entries()) {
      const output = join(directory, plan.outputName);
      await writeFile(output, prepared[index], { flag: 'wx', mode: 0o600 });
      validateOutput(await regularFile(output));
      outputs.push(output);
    }
    if ((await readdir(directory)).length !== 3) fail('OUTPUT');
    for (const plan of plans) if (hash(await regularFile(plan.path)) !== plan.sha256) fail('CHANGED');
  } catch (error) { if (error instanceof ScreenshotPreparationError) throw error; fail('OUTPUT'); }
  log('3枚のPNGを1179 × 2556pxで保存し、サイズとRGB形式を確認しました。元画像は上書きしていません。');
  log(`出力先：${directory}`);
  log('開いたフォルダーの3枚を、App Store ConnectのiPhone 6.1／6.3インチ欄へ追加してください。並びはホーム → お店 → 利用条件にします。');
  try { await openFolder(directory); } catch { log('フォルダーを自動で開けない場合は、表示された出力先を開いてください。'); }
  return { directory, files: outputs, size: { ...SCREENSHOT_SIZE } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) {
    console.error('使い方：node scripts/prepare-store-screenshots.mjs'); process.exitCode = 1;
  } else {
    await prepareStoreScreenshots().catch(error => {
      console.error(error instanceof ScreenshotPreparationError ? error.message : '[SCREENSHOT_FAILED] 画像の準備を完了できませんでした。元画像は上書きしていません。');
      process.exitCode = 1;
    });
  }
}
