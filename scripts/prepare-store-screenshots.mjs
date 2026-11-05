import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_SIZE = Object.freeze({ width: 1179, height: 2556 });
const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 100 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const messages = {
  PROJECT: '玉屋アプリのフォルダーで、Node.js 24以降を使って実行してください。',
  WINDOWS: 'この画像準備はWindowsのPCで実行してください。',
  CANCELLED: '画像の選択をキャンセルしたため終了しました。',
  PICKER: '画像を選ぶ画面を開くか、画像情報を読み取る処理を完了できませんでした。',
  SELECTION: 'ホーム・お店・利用条件の画像を、重複なしで3枚選んでください。',
  IMAGE: 'PNGまたはJPEGの通常の画像ファイルを選んでください。',
  SHAPE: 'スマートフォンの縦長画面として確認できません。横向きの画像や、画面の一部分だけの画像が選ばれていないか確認してください。',
  CHANGED: '選択した画像が処理中に変わったため終了しました。元画像を保存し直してから再実行してください。',
  RENDER: '画像の出力を完了できませんでした。元画像は上書きしていません。',
  OUTPUT: '出力したPNGのサイズ・形式を確認できませんでした。元画像は上書きしていません。',
};
export class ScreenshotPreparationError extends Error {
  constructor(code) { super(`[SCREENSHOT_${code}] ${messages[code]}`); this.code = code; }
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

const PS_COMMON = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
function Get-Orientation($image) {
  if ($image.PropertyIdList -contains 274) {
    $value = [BitConverter]::ToUInt16($image.GetPropertyItem(274).Value, 0)
    if ($value -ge 1 -and $value -le 8) { return $value }
  }
  return 1
}
function Set-Orientation($image, $orientation) {
  $mode = switch ($orientation) {
    2 { 'RotateNoneFlipX' } 3 { 'Rotate180FlipNone' }
    4 { 'Rotate180FlipX' } 5 { 'Rotate90FlipX' }
    6 { 'Rotate90FlipNone' } 7 { 'Rotate270FlipX' }
    8 { 'Rotate270FlipNone' } default { 'RotateNoneFlipNone' }
  }
  $image.RotateFlip([System.Drawing.RotateFlipType]$mode)
}
`;

export function buildPowerShellScript(operation) {
  if (operation === 'pick') return PS_COMMON + String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$owner = [System.Windows.Forms.Form]::new()
try {
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
  if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) { exit 3 }
  if ($dialog.FileNames.Count -ne 3) { exit 4 }
  $result = @()
  foreach ($path in $dialog.FileNames) {
    $info = [System.IO.FileInfo]::new($path)
    if ($info.Length -gt 104857600 -or ($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'invalid image' }
    $image = $null
    try {
      $image = [System.Drawing.Image]::FromFile($path)
      $format = if ($image.RawFormat.Guid -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid) { 'png' }
        elseif ($image.RawFormat.Guid -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid) { 'jpeg' }
        else { throw 'invalid image' }
      $rawWidth = $image.Width
      $rawHeight = $image.Height
      if ([long]$rawWidth * [long]$rawHeight -gt 40000000) { throw 'image too large' }
      $orientation = Get-Orientation $image
      Set-Orientation $image $orientation
      $result += @{ path = $path; width = $image.Width; height = $image.Height;
        rawWidth = $rawWidth; rawHeight = $rawHeight; orientation = $orientation; format = $format }
    } finally { if ($null -ne $image) { $image.Dispose() } }
  }
  @{ files = @($result) } | ConvertTo-Json -Depth 5 -Compress
} catch { exit 5 }
finally { $dialog.Dispose(); $owner.Dispose() }
`;
  if (operation === 'render') return PS_COMMON + String.raw`
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  if (-not $desktop -or -not [System.IO.Directory]::Exists($desktop)) { throw 'desktop missing' }
  if ([System.IO.Path]::GetFileName($payload.folderName) -ne $payload.folderName) { throw 'invalid output' }
  $directory = [System.IO.Path]::Combine($desktop, $payload.folderName)
  if ([System.IO.Directory]::Exists($directory) -or [System.IO.File]::Exists($directory)) { throw 'output exists' }
  [void][System.IO.Directory]::CreateDirectory($directory)
  $outputs = @()
  foreach ($plan in $payload.files) {
    $image = $null; $canvas = $null; $graphics = $null
    try {
      if ((Get-FileHash -LiteralPath $plan.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.sha256) { throw 'source changed' }
      $image = [System.Drawing.Image]::FromFile($plan.path)
      Set-Orientation $image (Get-Orientation $image)
      if ($image.Width -ne $plan.width -or $image.Height -ne $plan.height) { throw 'source changed' }
      $canvas = [System.Drawing.Bitmap]::new(1179, 2556, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [System.Drawing.Graphics]::FromImage($canvas)
      $graphics.Clear([System.Drawing.Color]::FromArgb(245, 242, 233))
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $rectangle = [System.Drawing.Rectangle]::new([int]$plan.x, [int]$plan.y, [int]$plan.drawWidth, [int]$plan.drawHeight)
      $graphics.DrawImage($image, $rectangle, 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel)
      $graphics.Dispose(); $graphics = $null
      $path = [System.IO.Path]::Combine($directory, $plan.outputName)
      $canvas.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $outputs += $path
    } finally {
      if ($null -ne $graphics) { $graphics.Dispose() }
      if ($null -ne $canvas) { $canvas.Dispose() }
      if ($null -ne $image) { $image.Dispose() }
    }
  }
  @{ directory = $directory; files = @($outputs) } | ConvertTo-Json -Depth 5 -Compress
} catch { exit 6 }
`;
  throw new TypeError('Unknown screenshot operation');
}

export function runWindowsPowerShell({ operation, script, input }) {
  try {
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 65536,
      input: input === undefined ? '' : JSON.stringify(input),
    });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch (error) {
    if (operation === 'pick' && error.status === 3) fail('CANCELLED');
    if (operation === 'pick' && error.status === 4) fail('SELECTION');
    fail(operation === 'pick' ? 'PICKER' : 'RENDER');
  }
}

async function regularFile(path) {
  const info = await lstat(path).catch(() => fail('IMAGE'));
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

function openExplorer(directory) {
  const child = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

export async function prepareStoreScreenshots({ root = process.cwd(), platform = process.platform,
  runWindows = runWindowsPowerShell, openFolder = openExplorer, log = console.log,
  now = () => new Date(), makeId = randomUUID } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('PROJECT');
  if (platform !== 'win32') fail('WINDOWS');
  root = await realpath(resolve(root));
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
    if (pkg.name !== 'tamaya-members-demo' || app?.owner !== 'oneight'
      || app?.ios?.bundleIdentifier !== 'jp.oneeight.tamaya.members') fail('PROJECT');
  } catch { fail('PROJECT'); }
  log('画像選択画面が開きます。ホーム・お店・利用条件の画像を3枚選んで「開く」を押してください。');
  const selected = await runWindows({ operation: 'pick', script: buildPowerShellScript('pick') });
  if (!object(selected) || !Array.isArray(selected.files) || selected.files.length !== 3) fail('SELECTION');
  const seen = new Set();
  const plans = [];
  for (const [index, file] of selected.files.entries()) {
    if (!object(file) || typeof file.path !== 'string' || !isAbsolute(file.path) || /[\u0000-\u001f]/.test(file.path)) fail('IMAGE');
    const path = resolve(file.path);
    const identity = path.toLowerCase();
    if (seen.has(identity)) fail('SELECTION');
    seen.add(identity);
    const bytes = await regularFile(path);
    const format = imageSignature(bytes, extname(path).toLowerCase());
    if (file.format !== format || !Number.isInteger(file.orientation) || file.orientation < 1 || file.orientation > 8
      || !Number.isSafeInteger(file.rawWidth) || !Number.isSafeInteger(file.rawHeight)
      || file.rawWidth <= 0 || file.rawHeight <= 0 || file.rawWidth * file.rawHeight > MAX_PIXELS) fail('IMAGE');
    if (format === 'png' && (bytes.readUInt32BE(16) !== file.rawWidth || bytes.readUInt32BE(20) !== file.rawHeight)) fail('IMAGE');
    const rotate = file.orientation >= 5;
    if (file.width !== (rotate ? file.rawHeight : file.rawWidth) || file.height !== (rotate ? file.rawWidth : file.rawHeight)) fail('IMAGE');
    const geometry = fitScreenshot(file.width, file.height);
    const stem = basename(path, extname(path)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'screenshot';
    plans.push({ path, sha256: hash(bytes), ...geometry, outputName: `${String(index + 1).padStart(2, '0')}-${stem}.png` });
    log(`${index + 1}枚目：${file.width} × ${file.height}px → 1179 × 2556px${geometry.upscaled ? '（拡大）' : ''}`);
    if (geometry.smallSource) log('元画像が小さいため、拡大しても細部の画質は戻りません。出力後の文字の見え方を確認してください。');
  }
  const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = makeId().replace(/-/g, '').slice(0, 12);
  if (!/^\d{8}-\d{6}$/.test(stamp) || !/^[a-f0-9]{12}$/.test(id)) fail('OUTPUT');
  const folderName = `Tamaya-AppStore-${stamp}-${id}`;
  const rendered = await runWindows({ operation: 'render', script: buildPowerShellScript('render'), input: { folderName, files: plans } });
  if (!object(rendered) || typeof rendered.directory !== 'string' || !isAbsolute(rendered.directory)
    || basename(rendered.directory) !== folderName || !Array.isArray(rendered.files) || rendered.files.length !== 3) fail('OUTPUT');
  const directory = resolve(rendered.directory);
  const directoryInfo = await lstat(directory).catch(() => fail('OUTPUT'));
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail('OUTPUT');
  const expected = plans.map(plan => plan.outputName).sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('OUTPUT');
  for (const [index, output] of rendered.files.entries()) {
    if (typeof output !== 'string' || !isAbsolute(output) || dirname(resolve(output)) !== directory
      || basename(output) !== plans[index].outputName || plans.some(plan => resolve(output).toLowerCase() === plan.path.toLowerCase())) fail('OUTPUT');
    const bytes = await regularFile(output).catch(() => fail('OUTPUT'));
    let format;
    try { format = imageSignature(bytes, '.png'); } catch { fail('OUTPUT'); }
    if (format !== 'png' || bytes.readUInt32BE(16) !== SCREENSHOT_SIZE.width
      || bytes.readUInt32BE(20) !== SCREENSHOT_SIZE.height || bytes[24] !== 8 || bytes[25] !== 2) fail('OUTPUT');
    if (hash(await regularFile(plans[index].path)) !== plans[index].sha256) fail('CHANGED');
  }
  log('3枚のPNGを1179 × 2556pxで保存し、サイズとRGB形式を確認しました。元画像は上書きしていません。');
  log(`出力先：${directory}`);
  log('開いたフォルダーの3枚を、App Store ConnectのiPhone 6.1／6.3インチ欄へ追加してください。並びはホーム → お店 → 利用条件にします。');
  log('この処理はサイズの準備です。Appleで受け付けられたことと、文字の見え方は追加後に確認します。');
  try { await openFolder(directory); } catch { log('フォルダーを自動で開けない場合は、表示された出力先を開いてください。'); }
  return { directory, files: rendered.files, size: { ...SCREENSHOT_SIZE } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) {
    console.error('使い方：node scripts/prepare-store-screenshots.mjs');
    process.exitCode = 1;
  } else {
    await prepareStoreScreenshots().catch(error => {
      console.error(error instanceof ScreenshotPreparationError ? error.message : '[SCREENSHOT_FAILED] 画像の準備を完了できませんでした。元画像は上書きしていません。');
      process.exitCode = 1;
    });
  }
}
