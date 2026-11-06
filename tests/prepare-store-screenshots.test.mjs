import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { buildPowerShellScript, fitScreenshot, prepareStoreScreenshots, renderScreenshot, runWindowsPowerShell, SCREENSHOT_SIZE } from '../scripts/prepare-store-screenshots.mjs';

const require = createRequire(import.meta.url);
const Jimp = require('jimp-compact');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const colors = [[40, 110, 70], [32, 70, 130], [220, 100, 40]];

function png(width, height, color = [0, 0, 0], colorType = 2) {
  const image = new PNG({ width, height });
  for (let at = 0; at < image.data.length; at += 4) {
    image.data[at] = color[0]; image.data[at + 1] = color[1]; image.data[at + 2] = color[2]; image.data[at + 3] = 255;
  }
  return PNG.sync.write(image, { colorType, inputColorType: 6 });
}
const validOutput = png(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height);
const corruptPng = bytes => { const copy = Buffer.from(bytes); copy[45] ^= 1; return copy; };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-screenshot-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = join(root, 'Desktop 日本語');
  await mkdir(desktop);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo' }));
  await writeFile(join(root, 'app.json'), JSON.stringify({ expo: { owner: 'oneight', ios: { bundleIdentifier: 'jp.oneeight.tamaya.members' } } }));
  const sizes = [[314, 687], [312, 674], [300, 650]];
  const files = [];
  for (const [index, [width, height]] of sizes.entries()) {
    const path = join(root, ['元画像 日本語.png', 'shop.png', 'rules.jpg'][index]);
    let bytes;
    if (index === 2) bytes = await new Jimp(width, height, Jimp.rgbaToInt(...colors[index], 255)).quality(95).getBufferAsync(Jimp.MIME_JPEG);
    else bytes = png(width, height, colors[index]);
    await writeFile(path, bytes);
    files.push(path);
  }
  const state = { files, desktop, opened: [], logs: [], selected: 0, rendered: [], outputBytes: null, mutateSource: false };
  const options = { root, platform: 'win32', selectImages: async () => {
    state.selected++;
    return { files: state.files, desktop: state.desktop };
  }, renderImage: async request => {
    state.rendered.push({ width: request.image.bitmap.width, height: request.image.bitmap.height, geometry: { ...request.geometry } });
    const result = state.outputBytes ?? await renderScreenshot(request);
    if (state.mutateSource) { state.mutateSource = false; await writeFile(state.files[0], png(315, 687)); }
    return result;
  }, openFolder: directory => state.opened.push(directory), log: line => state.logs.push(line),
  now: () => new Date('2026-11-06T01:02:03.000Z'), makeId: () => '01234567-89ab-cdef-0123-456789abcdef' };
  return { root, desktop, state, options, sizes };
}

function pixel(image, x, y) { return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]; }

test('fits the complete portrait without distortion or crop and centers only spare space', () => {
  for (const [width, height] of [[1179, 2556], [1206, 2622], [314, 687], [312, 674], [2000, 4300]]) {
    const geometry = fitScreenshot(width, height);
    assert.ok(geometry.drawWidth <= 1179 && geometry.drawHeight <= 2556);
    assert.ok(geometry.drawWidth === 1179 || geometry.drawHeight === 2556);
    assert.ok(Math.abs(geometry.drawWidth / width - geometry.drawHeight / height) <= 1 / width + 1 / height);
    assert.ok(Math.abs((1179 - geometry.drawWidth) / 2 - geometry.x) <= 0.5);
    assert.ok(Math.abs((2556 - geometry.drawHeight) / 2 - geometry.y) <= 0.5);
  }
  assert.equal(fitScreenshot(1179, 2556).scale, 1);
  assert.equal(fitScreenshot(314, 687).smallSource, true);
  assert.equal(fitScreenshot(1206, 2622).upscaled, false);
});

test('rejects tiny fragments, wide strips, invalid geometry and excessive pixel counts', () => {
  for (const dimensions of [[100, 217], [1300, 100], [1000, 1500], [600, 600], [10000, 22000], [NaN, 2556], [1179.5, 2556]]) {
    assert.throws(() => fitScreenshot(...dimensions), error => error.code === 'SHAPE');
  }
});

test('actually decodes PNG and JPEG and writes opaque exact-size raster copies without changing sources', async t => {
  const { root, desktop, state, options, sizes } = await fixture(t);
  const originals = await Promise.all(state.files.map(file => readFile(file)));
  const result = await prepareStoreScreenshots(options);
  assert.deepEqual(result.size, { width: 1179, height: 2556 });
  assert.match(basename(result.directory), /^Tamaya-AppStore-\d{8}-\d{6}-0123456789ab$/);
  assert.equal(join(desktop, basename(result.directory)), result.directory);
  assert.deepEqual(state.opened, [result.directory]);
  assert.deepEqual((await readdir(result.directory)).sort(), ['01-元画像 日本語.png', '02-shop.png', '03-rules.png'].sort());
  assert.equal(state.rendered.length, 3);
  for (const [index, file] of result.files.entries()) {
    const bytes = await readFile(file);
    assert.equal(bytes[25], 2, 'PNG uses RGB without an alpha channel');
    const image = PNG.sync.read(bytes);
    assert.equal(image.width, 1179); assert.equal(image.height, 2556);
    const center = pixel(image, 589, 1278);
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(center[channel] - colors[index][channel]) <= 2, 'original content colors survive real conversion');
    assert.equal(center[3], 255);
    const geometry = fitScreenshot(...sizes[index]);
    const border = geometry.drawWidth < 1179
      ? pixel(image, geometry.x > 0 ? 0 : 1178, 1278)
      : pixel(image, 589, geometry.y > 0 ? 0 : 2555);
    assert.deepEqual(border, [245, 242, 233, 255], 'spare space is the app background color');
    for (let at = 3; at < image.data.length; at += 4) assert.equal(image.data[at], 255);
    assert.deepEqual(await readFile(state.files[index]), originals[index]);
    assert.equal(digest(await readFile(state.files[index])), digest(originals[index]));
  }
  assert.ok(state.logs.some(line => line.includes('拡大しても細部の画質は戻りません')));
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.env')), []);
});

test('requires Windows and the intended app before opening the selector', async t => {
  const { root, state, options } = await fixture(t);
  await assert.rejects(prepareStoreScreenshots({ ...options, platform: 'linux' }), error => error.code === 'WINDOWS');
  await writeFile(join(root, 'app.json'), '{}');
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'PROJECT');
  assert.equal(state.selected, 0);
});

test('rejects missing, duplicate and symbolic-link sources before any image is rendered', async t => {
  const { root, desktop, state, options } = await fixture(t);
  const originals = [...state.files];
  state.files = originals.slice(0, 2);
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'SELECTION');
  state.files = [originals[0], originals[0], originals[2]];
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'SELECTION');
  state.files = [join(root, 'missing.png'), originals[1], originals[2]];
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  const link = join(root, 'linked.png'); await symlink(originals[0], link);
  state.files = [link, originals[1], originals[2]];
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  assert.equal(state.rendered.length, 0);
  assert.deepEqual(await readdir(desktop), []);
});

test('rejects unsupported or malformed source files before rendering', async t => {
  for (const content of [Buffer.from('not a PNG'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Buffer.alloc(32)]), corruptPng(png(314, 687))]) {
    await t.test(`source length ${content.length}`, async t => {
      const { desktop, state, options } = await fixture(t);
      await writeFile(state.files[0], content);
      await assert.rejects(prepareStoreScreenshots(options), error => ['IMAGE', 'IMAGE_READ'].includes(error.code));
      assert.equal(state.rendered.length, 0);
      assert.deepEqual(await readdir(desktop), []);
    });
  }
});

test('rejects an oversized source before decoding or output creation', async t => {
  const { desktop, state, options } = await fixture(t);
  const handle = await open(state.files[0], 'r+');
  await handle.truncate(100 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  assert.equal(state.rendered.length, 0);
  assert.deepEqual(await readdir(desktop), []);
});

test('refuses wrong-size, alpha-channel and malformed rendered PNGs without announcing success', async t => {
  for (const outputBytes of [png(1179, 2555), png(1179, 2556, [0, 0, 0], 6), Buffer.from('not a PNG'), corruptPng(validOutput)]) {
    await t.test(`output length ${outputBytes.length}`, async t => {
      const { state, options } = await fixture(t);
      state.outputBytes = outputBytes;
      await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'OUTPUT');
      assert.deepEqual(state.opened, []);
      assert.ok(!state.logs.some(line => line.includes('保存し、サイズとRGB形式を確認しました')));
    });
  }
});

test('detects a source changing during real rendering and does not open output as ready', async t => {
  const { state, options } = await fixture(t);
  state.mutateSource = true;
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'CHANGED');
  assert.deepEqual(state.opened, []);
});

test('does not overwrite an existing output directory on a repeated name', async t => {
  const { state, options } = await fixture(t);
  state.outputBytes = validOutput;
  const first = await prepareStoreScreenshots(options);
  const before = await Promise.all(first.files.map(file => readFile(file)));
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'OUTPUT');
  for (const [index, file] of first.files.entries()) assert.deepEqual(await readFile(file), before[index]);
  assert.equal(state.opened.length, 1);
});

test('the native selector returns paths only and captures CLIXML stderr instead of forwarding it', () => {
  const selection = { files: ['one.png', 'two.png', 'three.jpg'], desktop: 'C:\\Desktop' };
  let called = false;
  const result = runWindowsPowerShell({ execute: (command, args, options) => {
    called = true;
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(args.includes('-NonInteractive'));
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.equal(script, buildPowerShellScript());
    assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
    assert.ok(!/FromFile|RotateFlip|ReparsePoint/.test(script));
    return JSON.stringify(selection);
  } });
  assert.equal(called, true);
  assert.deepEqual(result, selection);
});

test('selector cancellation and native failures expose a safe code without private stderr or filename', () => {
  const privateStderr = '#< CLIXML private-file-name-and-unrelated-data';
  assert.throws(() => runWindowsPowerShell({ execute: () => {
    throw Object.assign(new Error('private exception message'), { status: 3, stderr: privateStderr });
  } }), error => error.code === 'CANCELLED' && !error.message.includes('private'));
  assert.throws(() => runWindowsPowerShell({ execute: () => {
    throw Object.assign(new Error('private exception message'), { status: 5, stderr: privateStderr,
      stdout: JSON.stringify({ phase: 'dialog', type: 'System.InvalidOperationException', hresult: -2146233079 }) });
  } }), error => error.code === 'PICKER' && error.message.includes('dialog:System.InvalidOperationException:-2146233079') && !error.message.includes('private'));
});
