import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareReviewAccount, REVIEW_ACCESS_NOTE, REVIEW_EAS_PROJECT_ID, REVIEW_JOURNAL, REVIEW_METADATA } from '../scripts/prepare-review-account.mjs';

const VERSION = '2026-11-04-1';
const base = {
  configVersion: 0,
  apple: { version: '1.0.0', copyright: '2026 private fixture owner',
    info: { ja: { title: 'むさしの玉屋', screenshots: { privateFixture: ['local-image.png'] } } },
    review: { firstName: 'Fixture', lastName: 'Reviewer', email: 'private-contact@example.invalid', phone: '+810000000000',
      demoRequired: true, notes: 'private note remains unchanged' },
    futurePrivateField: { keep: true } },
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tamaya-review-account-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'tamaya-members-demo' }));
  await writeFile(join(root, 'app.json'), JSON.stringify({ expo: { owner: 'oneight',
    extra: { eas: { projectId: REVIEW_EAS_PROJECT_ID } }, ios: { bundleIdentifier: 'jp.oneeight.tamaya.members' } } }));
  await writeFile(join(root, 'server/package.json'), '{}');
  await writeFile(join(root, '.gitignore'), '.env*\n');
  await writeFile(join(root, '.easignore'), '.env*\n');
  const env = 'EXPO_PUBLIC_APP_MODE=production\nEXPO_PUBLIC_API_URL=https://tamayaapp.onrender.com\nEXPO_PUBLIC_STORE_ID=tamaya\nEXPO_PUBLIC_FIREBASE_PROJECT_ID=tamayaapp\nEXPO_PUBLIC_FIREBASE_API_KEY=AIzaFixturePublicKeyLengthLongEnough1234\nOTHER_PRIVATE_VALUE=must-remain-opaque\n';
  await writeFile(join(root, '.env'), env);
  await writeFile(join(root, REVIEW_METADATA), JSON.stringify(base));
  const credentialsPath = join(root, '.env.fixture-admin.json');
  const credential = { type: 'service_account', project_id: 'tamayaapp',
    client_email: 'fixture@tamayaapp.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nfixture-not-a-key\n-----END PRIVATE KEY-----' };
  await writeFile(credentialsPath, JSON.stringify(credential));
  const state = { users: new Map(), member: null, staff: null, creates: 0, claims: 0, registrations: 0, factoryCalls: 0,
    closes: 0, requests: [], logs: [], failRegister: false, failClaims: false, failCreateAfterCommit: false };
  const auth = {
    async getUser(uid) {
      const value = state.users.get(uid);
      if (!value) throw Object.assign(new Error('private upstream detail'), { code: 'auth/user-not-found' });
      return structuredClone(value);
    },
    async createUser(input) {
      const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
      assert.equal(journal.phase, 'intent');
      assert.equal(journal.password, input.password);
      assert.equal(journal.uid, input.uid);
      assert.equal(input.emailVerified, true);
      state.creates++;
      state.users.set(input.uid, structuredClone(input));
      if (state.failCreateAfterCommit) { state.failCreateAfterCommit = false; throw new Error('private network uncertainty'); }
      return structuredClone(input);
    },
    async setCustomUserClaims(uid, claims) {
      state.claims++;
      if (state.failClaims) throw new Error('private claims detail');
      state.users.get(uid).customClaims = structuredClone(claims);
    },
  };
  const adminFactory = async ({ account }) => {
    state.factoryCalls++;
    assert.equal(account.project_id, 'tamayaapp');
    return { auth, close: async () => { state.closes++; } };
  };
  const request = async call => {
    state.requests.push(call);
    if (call.url.includes('identitytoolkit.googleapis.com/')) {
      const user = [...state.users.values()].find(user => user.email === call.body.email && user.password === call.body.password);
      if (!user || user.disabled) throw new Error('private credential failure');
      return { localId: user.uid, email: user.email, idToken: `fixture-token-${user.uid}` };
    }
    if (call.url.endsWith('/me/register')) {
      state.registrations++;
      const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
      assert.equal(call.headers['Idempotency-Key'], journal.registrationKey);
      assert.equal(call.body.acceptedTermsVersion, VERSION);
      assert.equal(call.body.acceptedPrivacyVersion, VERSION);
      assert.ok(!Object.hasOwn(call.body, 'stamps'));
      if (!state.member) state.member = { id: 'fixture-member', number: '1000000001', nickname: call.body.nickname, stamps: 0, coupons: [] };
      if (state.failRegister) { state.failRegister = false; throw new Error('timeout after server commit'); }
      return structuredClone(state.member);
    }
    if (call.url.endsWith('/me')) return { member: state.member ? structuredClone(state.member) : null, staff: state.staff };
    if (call.url.endsWith('/v1/stores/tamaya')) return { id: 'tamaya', legal: { termsVersion: VERSION, privacyVersion: VERSION } };
    assert.fail('Unexpected URL');
  };
  const options = { root, credentialsPath, adminFactory, request,
    download: async () => assert.fail('existing private metadata requires no download'),
    log: value => state.logs.push(value) };
  return { root, env, credentialsPath, credential, state, options };
}

test('prepares only a zero-balance customer through normal registration and keeps all private metadata', async t => {
  const { root, env, state, options } = await fixture(t);
  assert.deepEqual(await prepareReviewAccount(options), { phase: 'registered' });
  const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  assert.match(journal.uid, /^app-review-/);
  assert.match(journal.email, /@tamaya-review\.invalid$/);
  assert.match(journal.password, /^Aa9!/);
  assert.ok(journal.password.length >= 24);
  const metadata = JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8'));
  assert.equal(metadata.apple.review.demoUsername, journal.email);
  assert.equal(metadata.apple.review.demoPassword, journal.password);
  assert.equal(metadata.apple.review.demoRequired, true);
  assert.equal(metadata.apple.review.notes, base.apple.review.notes + '\n\n' + REVIEW_ACCESS_NOTE);
  const preparedNotes = metadata.apple.review.notes;
  metadata.apple.review.notes = base.apple.review.notes;
  delete metadata.apple.review.demoUsername; delete metadata.apple.review.demoPassword;
  assert.deepEqual(metadata, base);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), env);
  assert.equal(state.member.stamps, 0);
  assert.equal(state.staff, null);
  assert.deepEqual(Object.keys(state.users.get(journal.uid).customClaims), ['tamayaAppReview']);
  assert.equal(state.closes, 1);
  const logs = state.logs.join('\n');
  for (const privateValue of [journal.password, journal.email, options.credentialsPath, 'private-contact@example.invalid', 'fixture-not-a-key']) assert.ok(!logs.includes(privateValue));
  assert.ok(!state.requests.some(call => /sendOobCode|delete|staff|stamp|coupon/.test(call.url)));
  const before = await readFile(join(root, REVIEW_JOURNAL));
  await prepareReviewAccount(options);
  assert.equal(state.creates, 1);
  assert.equal(state.claims, 1);
  assert.deepEqual(await readFile(join(root, REVIEW_JOURNAL)), before);
  assert.equal(JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8')).apple.review.notes, preparedNotes);
});

test('wrong credential project stops before any network or account journal is created', async t => {
  const { root, credentialsPath, credential, state, options } = await fixture(t);
  await writeFile(credentialsPath, JSON.stringify({ ...credential, project_id: 'another-project' }));
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_CREDENTIALS_PROJECT');
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.requests.length, 0);
  await assert.rejects(readFile(join(root, REVIEW_JOURNAL)), { code: 'ENOENT' });
});

test('client emulator settings are rejected before credentials or network actions', async t => {
  const { root, env, state, options } = await fixture(t);
  await writeFile(join(root, '.env'), env + 'EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL=http://127.0.0.1:9099\n');
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_PROJECT');
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.requests.length, 0);
});

test('existing unrelated review credentials are never overwritten or used to create an account', async t => {
  const { root, state, options } = await fixture(t);
  const existing = { ...structuredClone(base), apple: { ...structuredClone(base.apple),
    review: { ...base.apple.review, demoUsername: 'existing@example.invalid', demoPassword: 'existing-private-password' } } };
  const before = JSON.stringify(existing);
  await writeFile(join(root, REVIEW_METADATA), before);
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_CONFLICT');
  assert.equal(await readFile(join(root, REVIEW_METADATA), 'utf8'), before);
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.requests.length, 0);
});

test('uncertain create response resumes from saved intent without resetting a user password', async t => {
  const { root, state, options } = await fixture(t);
  state.failCreateAfterCommit = true;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_AUTH');
  const intent = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  assert.equal(intent.phase, 'intent');
  assert.equal(state.users.size, 1);
  await prepareReviewAccount(options);
  assert.equal(state.creates, 1);
  const completed = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  assert.equal(completed.password, intent.password);
  assert.equal(completed.uid, intent.uid);
  assert.equal(completed.phase, 'registered');
});

test('known-created missing accounts are not recreated after withdrawal or external deletion', async t => {
  const { root, state, options } = await fixture(t);
  state.failClaims = true;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_AUTH');
  const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  assert.equal(journal.phase, 'created');
  state.users.clear();
  state.failClaims = false;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_ACCOUNT_MISSING');
  assert.equal(state.creates, 1);
});

test('wrong markers or identity are rejected without modifying the existing account', async t => {
  const { root, state, options } = await fixture(t);
  await prepareReviewAccount(options);
  const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  state.users.get(journal.uid).customClaims.tamayaAppReview.nonce = 'changed-elsewhere';
  const claims = state.claims;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_ACCOUNT_CONFLICT');
  assert.equal(state.claims, claims);
  assert.equal(state.creates, 1);
});

test('unknown existing users without marker require the saved password proof', async t => {
  const { root, state, options } = await fixture(t);
  state.failCreateAfterCommit = true;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_AUTH');
  const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  state.users.get(journal.uid).password = 'different-private-password';
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_LOGIN');
  assert.equal(state.claims, 0);
  assert.equal(state.registrations, 0);
});

test('unexpected additional claims cannot turn a provisioned review account into a privileged fixture', async t => {
  const { root, state, options } = await fixture(t);
  await prepareReviewAccount(options);
  const journal = JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8'));
  state.users.get(journal.uid).customClaims.admin = true;
  const claims = state.claims;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_ACCOUNT_CONFLICT');
  assert.equal(state.claims, claims);
  assert.equal(state.users.get(journal.uid).customClaims.admin, true);
});

test('register timeout remains resumable and never creates stamps or another authentication user', async t => {
  const { root, state, options } = await fixture(t);
  state.failRegister = true;
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_REGISTER');
  assert.equal(JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8')).phase, 'created');
  assert.equal(state.member.stamps, 0);
  await prepareReviewAccount(options);
  assert.equal(state.creates, 1);
  assert.equal(state.member.stamps, 0);
  assert.equal(JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8')).phase, 'registered');
});

test('staff privileges cause a stop without changing roles or writing review login metadata', async t => {
  const { root, state, options } = await fixture(t);
  state.staff = { role: 'owner', active: true };
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_ROLE');
  assert.equal(state.registrations, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8')), base);
});

test('target symlinks are refused before credentials or remote actions', async t => {
  const { root, state, options } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'tamaya-review-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, 'private.json');
  await writeFile(target, JSON.stringify(base));
  await rm(join(root, REVIEW_METADATA));
  await symlink(target, join(root, REVIEW_METADATA));
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_PRIVATE_FILE');
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.requests.length, 0);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), base);
});

test('private contact edits made during network work are preserved in the final metadata', async t => {
  const { root, options } = await fixture(t);
  const request = options.request;
  let edited = false;
  options.request = async call => {
    if (!edited && call.url.includes('identitytoolkit.googleapis.com/')) {
      const current = JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8'));
      current.apple.review.notes = 'newer private contact note';
      await writeFile(join(root, REVIEW_METADATA), JSON.stringify(current));
      edited = true;
    }
    return request(call);
  };
  await prepareReviewAccount(options);
  const metadata = JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8'));
  assert.equal(metadata.apple.review.notes, 'newer private contact note\n\n' + REVIEW_ACCESS_NOTE);
  assert.ok(metadata.apple.review.demoPassword);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.review-update-')));
});

test('missing private metadata can be initialized only from the pinned verified public template', async t => {
  const { root, options } = await fixture(t);
  await rm(join(root, REVIEW_METADATA));
  options.download = async ({ url, destination }) => {
    assert.ok(url.includes('/6ffe8dfb9391e5a633eafb31d9462c53dc2a43ae/deployment/store.config.json'));
    await writeFile(destination, await readFile(new URL('../deployment/store.config.json', import.meta.url)));
  };
  await prepareReviewAccount(options);
  const metadata = JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8'));
  assert.equal(metadata.apple.info.ja.title, 'むさしの玉屋');
  assert.ok(metadata.apple.review.demoUsername);
  assert.ok(metadata.apple.review.demoPassword);
});

test('tampered public template cannot create an authentication account or credential journal', async t => {
  const { root, state, options } = await fixture(t);
  await rm(join(root, REVIEW_METADATA));
  options.download = async ({ destination }) => writeFile(destination, '{"configVersion":0}');
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_TEMPLATE');
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.requests.length, 0);
  await assert.rejects(readFile(join(root, REVIEW_JOURNAL)), { code: 'ENOENT' });
});

test('later ignore negations stop preparation before credential use or secret writes', async t => {
  for (const policy of ['.gitignore', '.easignore']) {
    for (const target of [REVIEW_JOURNAL, REVIEW_METADATA, '.env.review-update-*.tmp']) {
      await t.test(`${policy}: ${target}`, async t => {
        const { root, state, options } = await fixture(t);
        await writeFile(join(root, policy), `.env*\n!${target}\n`);
        await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_IGNORE');
        assert.equal(state.factoryCalls, 0);
        assert.equal(state.requests.length, 0);
        assert.deepEqual(JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8')), base);
        await assert.rejects(readFile(join(root, REVIEW_JOURNAL)), { code: 'ENOENT' });
      });
    }
  }
});

test('last matching ignore rule can restore private-file protection', async t => {
  const { root, options } = await fixture(t);
  await writeFile(join(root, '.gitignore'), '.env*\n!.env.*\n.env*\n');
  assert.deepEqual(await prepareReviewAccount(options), { phase: 'registered' });
});

test('changed temporary-file protection during network requests prevents later private writes', async t => {
  const { root, options } = await fixture(t);
  const request = options.request;
  options.request = async call => {
    const response = await request(call);
    if (call.url.includes('identitytoolkit.googleapis.com/')) {
      await writeFile(join(root, '.easignore'), '.env*\n!.env.review-update-*.tmp\n');
    }
    return response;
  };
  await assert.rejects(prepareReviewAccount(options), error => error.code === 'REVIEW_IGNORE');
  assert.equal(JSON.parse(await readFile(join(root, REVIEW_METADATA), 'utf8')).apple.review.demoPassword, undefined);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.env.review-update-')));
  assert.equal(JSON.parse(await readFile(join(root, REVIEW_JOURNAL), 'utf8')).phase, 'created');
});
