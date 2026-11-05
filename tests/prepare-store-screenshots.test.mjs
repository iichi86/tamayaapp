import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { fitScreenshot, prepareStoreScreenshots, SCREENSHOT_SIZE } from '../scripts/prepare-store-screenshots.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const contents = Buffer.concat([Buffer.from(type), data]);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(contents));
  return Buffer.concat([prefix, contents, crc]);
}
function png(width, height, colorType = 2) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = colorType;
  const rows = Buffer.alloc((width * (colorType === 6 ? 4 : 3) + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const outputPng = png(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-screenshot-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo' }));
  await writeFile(join(root, 'app.json'), JSON.stringify({ expo: { owner: 'oneight', ios: { bundleIdentifier: 'jp.oneeight.tamaya.members' } } }));
  const sizes = [[314, 687], [312, 674], [300, 650]];
  const files = [];
  for (const [index, [width, height]] of sizes.entries()) {
    const path = join(root, ['元画像 日本語.png', 'shop.png', 'rules.png'][index]);
    await writeFile(path, png(width, height));
    files.push({ path, width, height, rawWidth: width, rawHeight: height, orientation: 1, format: 'png' });
  }
  const state = { files, calls: [], opened: [], logs: [], payload: null, rendered: null,
    outputBytes: outputPng, mutateSource: false, badManifest: false };
  const runWindows = async ({ operation, input }) => {
    state.calls.push(operation);
    if (operation === 'pick') return { files: state.files };
    state.payload = input;
    const directory = join(root, input.folderName);
    await mkdir(directory);
    const outputs = [];
    for (const file of input.files) {
      const path = join(directory, file.outputName);
      await writeFile(path, state.outputBytes);
      outputs.push(path);
    }
    if (state.mutateSource) await writeFile(state.files[0].path, png(315, 687));
    state.rendered = { directory, files: outputs };
    return state.badManifest ? { ...state.rendered, files: [...outputs].reverse() } : state.rendered;
  };
  const options = { root, platform: 'win32', runWindows, openFolder: directory => state.opened.push(directory),
    log: line => state.logs.push(line), now: () => new Date('2026-11-06T01:02:03.000Z'),
    makeId: () => '01234567-89ab-cdef-0123-456789abcdef' };
  return { root, state, options };
}

test('fits the complete portrait without distortion or crop and centers only the spare space', () => {
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

test('prepares verified RGB PNG copies in a unique folder and leaves original bytes untouched', async t => {
  const { root, state, options } = await fixture(t);
  const originals = await Promise.all(state.files.map(file => readFile(file.path)));
  const result = await prepareStoreScreenshots(options);
  assert.deepEqual(state.calls, ['pick', 'render']);
  assert.deepEqual(result.size, { width: 1179, height: 2556 });
  assert.equal(basename(result.directory), 'Tamaya-AppStore-20261106-010203-0123456789ab');
  assert.deepEqual(state.opened, [result.directory]);
  assert.deepEqual((await readdir(result.directory)).sort(), ['01-元画像 日本語.png', '02-shop.png', '03-rules.png'].sort());
  for (const [index, file] of state.payload.files.entries()) {
    const expected = fitScreenshot(state.files[index].width, state.files[index].height);
    for (const key of Object.keys(expected)) assert.equal(file[key], expected[key]);
    assert.equal(file.sha256, createHash('sha256').update(originals[index]).digest('hex'));
    assert.deepEqual(await readFile(state.files[index].path), originals[index]);
  }
  assert.ok(state.logs[0].includes('画像選択画面'));
  assert.ok(state.logs.some(line => line.includes('拡大しても細部の画質は戻りません')));
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.env')), []);
});

test('requires the Windows app folder before invoking a picker', async t => {
  const { root, state, options } = await fixture(t);
  await assert.rejects(prepareStoreScreenshots({ ...options, platform: 'linux' }), error => error.code === 'WINDOWS');
  await writeFile(join(root, 'app.json'), '{}');
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'PROJECT');
  assert.deepEqual(state.calls, []);
});

test('requires exactly three distinct images and refuses a source symlink before output', async t => {
  const { root, state, options } = await fixture(t);
  const initial = [...state.files];
  state.files = initial.slice(0, 2);
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'SELECTION');
  state.files = [initial[0], initial[0], initial[2]];
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'SELECTION');
  const path = join(root, 'linked.png');
  await symlink(initial[0].path, path);
  state.files = [{ ...initial[0], path }, initial[1], initial[2]];
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  assert.ok(!state.calls.includes('render'));
});

test('validates the source signature and actual PNG dimensions instead of trusting picker metadata', async t => {
  const { state, options } = await fixture(t);
  await writeFile(state.files[0].path, Buffer.from('not a PNG'));
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  await writeFile(state.files[0].path, png(315, 687));
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'IMAGE');
  assert.ok(!state.calls.includes('render'));
});

test('refuses output with the wrong dimensions or alpha channel and never opens it as ready', async t => {
  for (const outputBytes of [png(1179, 2555), png(1179, 2556, 6), Buffer.from('not a PNG')]) {
    await t.test(`output length ${outputBytes.length}`, async t => {
      const { state, options } = await fixture(t);
      state.outputBytes = outputBytes;
      await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'OUTPUT');
      assert.deepEqual(state.opened, []);
      assert.ok(!state.logs.some(line => line.includes('保存し、サイズとRGB形式を確認しました')));
    });
  }
});

test('does not accept a renderer manifest pointing at reordered or unrelated files', async t => {
  const { state, options } = await fixture(t);
  state.badManifest = true;
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'OUTPUT');
  assert.deepEqual(state.opened, []);
});

test('detects source changes during rendering and leaves the output unannounced', async t => {
  const { state, options } = await fixture(t);
  state.mutateSource = true;
  await assert.rejects(prepareStoreScreenshots(options), error => error.code === 'CHANGED');
  assert.deepEqual(state.opened, []);
});
