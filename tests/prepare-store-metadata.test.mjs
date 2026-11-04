import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { APP_ID, BUNDLE_ID, PRIVATE_FILE, PROJECT_ID,
  isPrivateFileIgnored, mergePublicMetadata, prepareStoreMetadata } from '../scripts/prepare-store-metadata.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicBytes = await readFile(join(projectRoot, 'deployment/store.config.json'));
const publicConfig = JSON.parse(publicBytes);
const originalEnv = 'OTHER_PRIVATE_VALUE=keep-opaque-secret\r\n';
const app = { expo: { owner: 'oneight', version: '1.0.0', ios: { bundleIdentifier: BUNDLE_ID }, extra: { eas: { projectId: PROJECT_ID } } } };
const answers = { copyright: '', firstName: 'FixtureFirst', lastName: 'FixtureLast', email: 'owner-fixture@example.net', phone: '+818000000000' };
const quiet = () => {};
const download = async ({ destination }) => writeFile(destination, publicBytes);
const lint = async () => '[]';
const ask = async ({ field }) => answers[field];

async function fixture(t, privateConfig) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-store-wizard-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo' }));
  await writeFile(join(root, 'app.json'), JSON.stringify(app));
  await writeFile(join(root, 'eas.json'), JSON.stringify({
    build: { production: { node: '24.19.0', env: { EXPO_PUBLIC_APP_MODE: 'production' } } },
    submit: { production: { ios: { bundleIdentifier: BUNDLE_ID, language: 'ja', customMarker: 'keep-eas-value' } } },
  }, null, 2) + '\n');
  await writeFile(join(root, '.env'), originalEnv);
  await copyFile(join(projectRoot, '.gitignore'), join(root, '.gitignore'));
  await copyFile(join(projectRoot, '.easignore'), join(root, '.easignore'));
  if (privateConfig !== undefined) await writeFile(join(root, PRIVATE_FILE), JSON.stringify(privateConfig, null, 2) + '\n');
  return root;
}

async function state(root) {
  const output = {};
  for (const name of ['eas.json', '.env', PRIVATE_FILE]) {
    try { output[name] = await readFile(join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') output[name] = null; else throw error; }
  }
  return output;
}

test('creates a private config from checked public text and reuses contact values on rerun', async t => {
  const root = await fixture(t);
  const prompts = [];
  const messages = [];
  const collect = async entry => { prompts.push(entry.field); return ask(entry); };
  const result = await prepareStoreMetadata({ root, ask: collect, download, lint, log: message => messages.push(message) });
  assert.equal(result.hasDemoCredentials, false);
  assert.deepEqual(prompts, ['copyright', 'lastName', 'firstName', 'email']);
  const data = JSON.parse(await readFile(join(root, PRIVATE_FILE), 'utf8'));
  assert.deepEqual(data.apple.info.ja, publicConfig.apple.info.ja);
  assert.equal(data.apple.copyright, '2026 ワンエイト');
  assert.equal(data.apple.review.phone, '+818049097012');
  assert.equal(data.apple.review.demoRequired, true);
  assert.ok(!Object.hasOwn(data.apple.review, 'demoUsername'));
  assert.ok(!Object.hasOwn(data.apple.review, 'demoPassword'));
  assert.ok(messages.some(message => message.includes('準備はまだ完了していません')));
  assert.ok(!messages.join('\n').includes(answers.email));
  assert.ok(!messages.join('\n').includes(answers.firstName));
  const eas = JSON.parse(await readFile(join(root, 'eas.json'), 'utf8'));
  assert.equal(eas.submit.production.ios.ascAppId, APP_ID);
  assert.equal(eas.submit.production.ios.metadataPath, PRIVATE_FILE);
  assert.equal(eas.submit.production.ios.customMarker, 'keep-eas-value');
  assert.equal(eas.build.production.node, '24.19.0');
  assert.equal(await readFile(join(root, '.env'), 'utf8'), originalEnv);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, PRIVATE_FILE))).mode & 0o777, 0o600);
  const before = await state(root);
  await prepareStoreMetadata({ root, ask: async () => assert.fail('must reuse saved values'), download, lint, log: quiet });
  assert.deepEqual(await state(root), before);
});

test('preserves credentials, screenshots, unknown fields, extra languages and existing copyright', async t => {
  const existing = {
    configVersion: 0, unknownTop: { marker: 'opaque-top' },
    apple: { version: '1.0.0', copyright: '2026 Fixture Rights Holder', unknownApple: ['keep'],
      info: { ja: { title: 'old title', screenshots: { APP_IPHONE_67: ['private-shot.png'] }, customJa: 'keep-ja' }, en: { title: 'existing-other-language' } },
      review: { firstName: answers.firstName, lastName: answers.lastName, email: answers.email, phone: '+81 80 0000 0000',
        demoRequired: true, demoUsername: 'demo-private@example.net', demoPassword: 'PRIVATE-REVIEW-PASSWORD', notes: 'Existing private instructions', otherField: 'opaque-review' } },
  };
  const root = await fixture(t, existing);
  const messages = [];
  const result = await prepareStoreMetadata({ root, ask: async () => assert.fail('must not ask known contact values'), download, lint, log: message => messages.push(message) });
  const data = JSON.parse(await readFile(join(root, PRIVATE_FILE), 'utf8'));
  assert.equal(result.hasDemoCredentials, true);
  assert.equal(data.apple.review.demoPassword, existing.apple.review.demoPassword);
  assert.equal(data.apple.review.demoUsername, existing.apple.review.demoUsername);
  assert.deepEqual(data.apple.review, existing.apple.review);
  assert.equal(data.apple.copyright, existing.apple.copyright);
  assert.deepEqual(data.unknownTop, existing.unknownTop);
  assert.deepEqual(data.apple.unknownApple, existing.apple.unknownApple);
  assert.deepEqual(data.apple.info.en, existing.apple.info.en);
  assert.deepEqual(data.apple.info.ja.screenshots, existing.apple.info.ja.screenshots);
  assert.equal(data.apple.info.ja.customJa, 'keep-ja');
  assert.equal(data.apple.info.ja.title, publicConfig.apple.info.ja.title);
  for (const value of ['PRIVATE-REVIEW-PASSWORD', answers.email, answers.firstName, 'demo-private@example.net']) {
    assert.ok(!messages.join('\n').includes(value));
  }
});

test('tampered or interrupted downloads cannot change local metadata or EAS settings', async t => {
  for (const corrupt of [true, false]) {
    const root = await fixture(t);
    const before = await state(root);
    await assert.rejects(prepareStoreMetadata({ root, ask: async () => assert.fail('must not ask'), lint: async () => assert.fail('must not lint'), log: quiet,
      download: async ({ destination }) => {
        if (corrupt) await writeFile(destination, 'unexpected download body');
        else throw new Error('untrusted upstream body including private-looking data');
      } }));
    assert.deepEqual(await state(root), before);
  }
});

test('invalid lint output restores existing private bytes and all original EAS settings', async t => {
  const existing = { configVersion: 0, apple: { version: '1.0.0', customPrivate: 'keep-private-existing' } };
  for (const output of ['[{"path":"apple.review.email","message":"untrusted fixture"}]', 'not json']) {
    const root = await fixture(t, existing);
    const before = await state(root);
    await assert.rejects(prepareStoreMetadata({ root, ask, download, lint: async () => output, log: quiet }), /元に戻しました/);
    assert.deepEqual(await state(root), before);
    assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.metadata-update-')));
  }
});

test('failed lint removes a newly created private file rather than leaving partial setup', async t => {
  const root = await fixture(t);
  const before = await state(root);
  await assert.rejects(prepareStoreMetadata({ root, ask, download, log: quiet,
    lint: async () => { throw new Error('PRIVATE-RAW-LINT-ERROR'); } }), error => {
    assert.ok(!error.message.includes('PRIVATE-RAW-LINT-ERROR'));
    return /元に戻しました/.test(error.message);
  });
  assert.deepEqual(await state(root), before);
});

test('checks file existence and correct metadataPath before trusting an empty lint result', async t => {
  const root = await fixture(t);
  let called = false;
  await prepareStoreMetadata({ root, ask, download, log: quiet, lint: async ({ root: checkedRoot }) => {
    called = true;
    assert.equal(checkedRoot, root);
    const eas = JSON.parse(await readFile(join(root, 'eas.json'), 'utf8'));
    assert.equal(eas.submit.production.ios.metadataPath, PRIVATE_FILE);
    const config = JSON.parse(await readFile(join(root, PRIVATE_FILE), 'utf8'));
    assert.equal(config.apple.review.email, answers.email);
    return '[]';
  } });
  assert.equal(called, true);
});

test('rejects a different app, alternate private path, or symlink before downloading', async t => {
  for (const variant of ['project', 'app', 'path', 'link']) {
    const root = await fixture(t);
    if (variant === 'project') {
      const different = structuredClone(app); different.expo.extra.eas.projectId = 'another-project';
      await writeFile(join(root, 'app.json'), JSON.stringify(different));
    } else if (variant === 'app' || variant === 'path') {
      const eas = JSON.parse(await readFile(join(root, 'eas.json'), 'utf8'));
      if (variant === 'app') eas.submit.production.ios.ascAppId = '9999999999';
      else eas.submit.production.ios.metadataPath = '.env.other-private-config.json';
      await writeFile(join(root, 'eas.json'), JSON.stringify(eas));
    } else {
      const outside = join(await mkdtemp(join(tmpdir(), 'tamaya-store-outside-')), 'private.json');
      t.after(() => rm(dirname(outside), { recursive: true, force: true }));
      await writeFile(outside, 'outside-private-bytes');
      await symlink(outside, join(root, PRIVATE_FILE), 'file');
    }
    await assert.rejects(prepareStoreMetadata({ root, ask, log: quiet,
      download: async () => assert.fail('must reject before downloading'), lint: async () => assert.fail('must not lint') }));
  }
});

test('refuses to write private information if Git or EAS ignore protection is absent', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.easignore'), '.env*\n!.env.store.config.json\n');
  const before = await state(root);
  await assert.rejects(prepareStoreMetadata({ root, ask, log: quiet,
    download: async () => assert.fail('must not download') }), /除外/);
  assert.deepEqual(await state(root), before);
  assert.equal(isPrivateFileIgnored('.env*\n!.env.example\n!/server/config\n'), true);
  assert.equal(isPrivateFileIgnored('.env*\n!*.json\n'), false);
  assert.equal(isPrivateFileIgnored('.env*\n!**/.env.store.config.json\n'), false);
  assert.equal(isPrivateFileIgnored('.env*\n!.env[.]store.config.json\n'), false);
  assert.equal(isPrivateFileIgnored('.env*\n!**/**/.env.store.config.json\n'), false);
});

test('rejects temporary-file unignore rules in either policy before downloading or prompting', async t => {
  for (const ignoreFile of ['.gitignore', '.easignore']) {
    for (const rule of ['!.env.metadata-update-*', '!*.tmp']) {
      const root = await fixture(t);
      await writeFile(join(root, ignoreFile), `.env*\n${rule}\n`);
      const before = await state(root);
      await assert.rejects(prepareStoreMetadata({ root, log: quiet,
        ask: async () => assert.fail('must not prompt'),
        download: async () => assert.fail('must not download') }), /作業用ファイル/);
      assert.deepEqual(await state(root), before);
      assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.metadata-update-')));
    }
  }
  const temporary = '.env.metadata-update-12345678-1234-4234-8234-123456789abc.tmp';
  assert.equal(isPrivateFileIgnored('.env*\n', temporary), true);
  assert.equal(isPrivateFileIgnored('.env*\n!.env.metadata-update-*\n', temporary), false);
  assert.equal(isPrivateFileIgnored(`.env*\n!${temporary}\n`, temporary), false);
});

test('rechecks temporary-file protection if an ignore policy changes during prompting', async t => {
  const root = await fixture(t);
  const before = await state(root);
  let changed = false;
  await assert.rejects(prepareStoreMetadata({ root, download, lint, log: quiet,
    ask: async entry => {
      if (!changed) {
        await writeFile(join(root, '.easignore'), '.env*\n!.env.metadata-update-*\n');
        changed = true;
      }
      return ask(entry);
    } }), /作業用ファイル/);
  assert.deepEqual(await state(root), before);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.metadata-update-')));
});

test('never resets another metadata version and retains user edits made during validation', async t => {
  assert.throws(() => mergePublicMetadata({ apple: { version: '2.0.0' } }, publicConfig), /1.0.0/);
  const root = await fixture(t);
  const edited = Buffer.from('{"localEdit":"do-not-overwrite-this-private-file"}\n');
  await assert.rejects(prepareStoreMetadata({ root, ask, download, log: quiet,
    lint: async () => { await writeFile(join(root, PRIVATE_FILE), edited); return '[]'; } }), /他の変更を保護/);
  assert.deepEqual(await readFile(join(root, PRIVATE_FILE)), edited);
});

test('--edit changes selected contact fields while keeping existing demo credentials', async t => {
  const root = await fixture(t, { configVersion: 0, apple: { version: '1.0.0', copyright: '2026 Existing Rights',
    review: { firstName: 'OldFirst', lastName: 'OldLast', email: 'old-fixture@example.net', phone: '+818000000001',
      demoRequired: true, demoUsername: 'demo-existing@example.net', demoPassword: 'PRIVATE-EXISTING-PASSWORD' } } });
  const prompts = [];
  await prepareStoreMetadata({ root, edit: true, download, lint, log: quiet,
    ask: async entry => { prompts.push(entry.field); return entry.field === 'email' ? answers.email : ''; } });
  const data = JSON.parse(await readFile(join(root, PRIVATE_FILE), 'utf8'));
  assert.deepEqual(prompts, ['copyright', 'lastName', 'firstName', 'email', 'phone']);
  assert.equal(data.apple.review.email, answers.email);
  assert.equal(data.apple.review.firstName, 'OldFirst');
  assert.equal(data.apple.copyright, '2026 Existing Rights');
  assert.equal(data.apple.review.demoPassword, 'PRIVATE-EXISTING-PASSWORD');
});

