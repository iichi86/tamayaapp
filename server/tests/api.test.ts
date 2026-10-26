import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { createDemoVerifier } from '../src/auth.js';
import { ServerDatabase } from '../src/database.js';
import type { MemberView, TokenVerifier } from '../src/types.js';

const NOW = '2026-10-27T02:00:00.000Z';
const prefix = '/api/stores/tamaya';
const resources: Array<{ app: FastifyInstance; db: ServerDatabase }> = [];

afterEach(async () => {
  for (const { app, db } of resources.splice(0)) { await app.close(); db.close(); }
});

async function fixture(verifier: TokenVerifier = createDemoVerifier(), demoMode = true) {
  let clock = new Date(NOW);
  const db = new ServerDatabase(':memory:', { now: () => clock });
  const seeded = db.seedDemo();
  const app = await createApp({ db, verifier, qrSecret: 'api-test-signing-secret-32-characters-long', now: () => clock, demoMode, demoHtml: '<html lang="ja">試用画面</html>' });
  resources.push({ app, db });
  await app.ready();
  const call = (uid: string | null, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, key?: string) => app.inject({
    method, url: path,
    headers: {
      ...(uid ? { authorization: `Bearer ${uid}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(payload ? { payload } : {}),
  });
  return { app, db, memberId: seeded.memberId, call, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('management HTTP API authorization and validation', () => {
  it('permits public store information while refusing unauthenticated, forged, and customer staff operations', async () => {
    const f = await fixture();
    expect((await f.call(null, 'GET', prefix)).statusCode).toBe(200);
    expect((await f.call(null, 'GET', `${prefix}/notices`)).json()).toHaveLength(1);
    expect((await f.call(null, 'GET', `${prefix}/me`)).statusCode).toBe(401);
    expect((await f.call('unknown-owner', 'GET', `${prefix}/staff/stats`)).statusCode).toBe(401);
    expect((await f.call('demo-customer', 'GET', `${prefix}/staff/members`)).statusCode).toBe(403);
    expect((await f.call('demo-customer', 'POST', `${prefix}/staff/members/${f.memberId}/stamps`, {}, 'self-grant')).statusCode).toBe(403);
    expect((await f.call('demo-customer', 'PUT', `${prefix}/staff/accounts/demo-customer`, { role: 'owner', active: true }, 'self-promote')).statusCode).toBe(403);
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/accounts`)).statusCode).toBe(403);
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/audit`)).statusCode).toBe(403);
    expect(f.db.getMember('tamaya', f.memberId).stamps).toBe(9);
  });

  it('registers the authenticated member at zero and rejects client-selected balance or clock', async () => {
    const f = await fixture();
    const forged = await f.call('demo-new-customer', 'POST', `${prefix}/memberships`, { nickname: '新規会員', stamps: 999, role: 'owner' });
    expect(forged.statusCode).toBe(400);
    const created = await f.call('demo-new-customer', 'POST', `${prefix}/memberships`, { nickname: '新規会員' });
    expect(created.statusCode).toBe(200);
    const member = created.json<MemberView>();
    expect(member).toMatchObject({ nickname: '新規会員', stamps: 0 });
    expect((await f.call('demo-new-customer', 'POST', `${prefix}/memberships`, { nickname: '再送' })).json().id).toBe(member.id);
    expect((await f.call('demo-new-customer', 'GET', `${prefix}/me`)).json().id).toBe(member.id);
    expect((await f.call('demo-customer', 'GET', `${prefix}/me`)).json().id).toBe(f.memberId);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/members/${member.id}/stamps`, { now: '2099-01-01' }, 'forged-clock')).statusCode).toBe(400);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/members/${member.id}/stamps`, {})).statusCode).toBe(400);
    expect(f.db.getMember('tamaya', member.id).stamps).toBe(0);
  });

  it('isolates stores even when Firebase project identities overlap', async () => {
    const f = await fixture();
    f.db.createStore({ id: 'other', name: '別店舗の試験', firebaseProjectId: 'demo-tamaya', stampsRequired: 10, discountYen: 100, validityDays: 30 });
    const other = f.db.registerMember('other', { uid: 'demo-customer', projectId: 'demo-tamaya' }, '別店舗会員');
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/members/${other.id}`)).statusCode).toBe(404);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/members/${other.id}/stamps`, {}, 'other-member')).statusCode).toBe(404);
    expect((await f.call('demo-owner', 'GET', '/api/stores/other/staff/members')).statusCode).toBe(403);
    f.db.createStore({ id: 'other-project', name: '別認証の試験', firebaseProjectId: 'separate-project', stampsRequired: 10, discountYen: 100, validityDays: 30 });
    expect((await f.call('demo-customer', 'GET', '/api/stores/other-project/me')).statusCode).toBe(401);
  });

  it('does not trust an injected identity for a different Firebase project or expose verifier errors', async () => {
    const wrongProject = await fixture({ verify: async () => ({ uid: 'demo-owner', projectId: 'not-the-store-project' }) });
    expect((await wrongProject.call('any', 'GET', `${prefix}/staff/stats`)).statusCode).toBe(401);
    const unavailable = await fixture({ verify: async () => { throw new Error('private-credential-path-and-bearer-token'); } });
    const reply = await unavailable.call('sensitive-token', 'GET', `${prefix}/me`);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).not.toContain('private-credential');
    expect(reply.body).not.toContain('sensitive-token');
  });
});

describe('server-confirmed rewards and staff changes', () => {
  it('handles simultaneous retry requests once, rejects changed requests, and redeems once', async () => {
    const f = await fixture();
    const path = `${prefix}/staff/members/${f.memberId}/stamps`;
    const grants = await Promise.all(Array.from({ length: 12 }, () => f.call('demo-staff', 'POST', path, {}, 'same-grant-request')));
    expect(grants.every((reply) => reply.statusCode === 200)).toBe(true);
    expect(new Set(grants.map((reply) => reply.body)).size).toBe(1);
    const result = grants[0].json();
    expect(result.member.stamps).toBe(0);
    expect(result.coupon).toMatchObject({ discountYen: 100, status: 'available' });
    expect(f.db.getMember('tamaya', f.memberId).coupons.filter((coupon) => coupon.status === 'available')).toHaveLength(1);
    const repeats = await Promise.all(Array.from({ length: 8 }, (_, index) => f.call('demo-staff', 'POST', path, {}, `another-grant-${index}`)));
    expect(repeats.every((reply) => reply.statusCode === 409)).toBe(true);
    const redeemPath = `${prefix}/staff/coupons/${result.coupon.id}/redeem`;
    expect((await f.call('demo-staff', 'POST', redeemPath, {}, 'same-grant-request')).statusCode).toBe(409);
    const redeemed = await f.call('demo-staff', 'POST', redeemPath, {}, 'redeem-once');
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().coupon.status).toBe('used');
    expect((await f.call('demo-staff', 'POST', redeemPath, {}, 'redeem-once')).body).toBe(redeemed.body);
    expect((await f.call('demo-staff', 'POST', redeemPath, {}, 'redeem-again')).statusCode).toBe(409);
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/stats`)).json()).toEqual({ members: 1, stampsToday: 1, redemptionsToday: 1 });
  });

  it('rejects expired and already used sample coupons without changing the member', async () => {
    const f = await fixture();
    for (const coupon of f.db.getMember('tamaya', f.memberId).coupons) {
      expect((await f.call('demo-staff', 'POST', `${prefix}/staff/coupons/${coupon.id}/redeem`, {}, `reject-${coupon.id}`)).statusCode).toBe(409);
    }
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/stats`)).json()).toEqual({ members: 1, stampsToday: 0, redemptionsToday: 0 });
  });

  it('edits notices with replay protection and immediately revokes a staff token', async () => {
    const f = await fixture();
    const body = { title: '店頭からのお知らせ', body: '登録した本文です。' };
    const added = await f.call('demo-staff', 'POST', `${prefix}/staff/notices`, body, 'new-notice');
    expect(added.statusCode).toBe(200);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/notices`, body, 'new-notice')).body).toBe(added.body);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/notices`, { ...body, title: '違う内容' }, 'new-notice')).statusCode).toBe(409);
    expect((await f.call(null, 'GET', `${prefix}/notices`)).json()).toHaveLength(2);
    expect((await f.call('demo-staff', 'PUT', `${prefix}/staff/notices/${added.json().id}`, { ...body, body: '編集後です。' }, 'edit-notice')).statusCode).toBe(200);
    const revoked = await f.call('demo-owner', 'PUT', `${prefix}/staff/accounts/demo-staff`, { role: 'staff', active: false }, 'revoke-staff');
    expect(revoked.statusCode).toBe(200);
    expect((await f.call('demo-staff', 'GET', `${prefix}/staff/stats`)).statusCode).toBe(403);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/notices`, body, 'new-notice')).statusCode).toBe(403);
    const demoteLastOwner = await f.call('demo-owner', 'PUT', `${prefix}/staff/accounts/demo-owner`, { role: 'staff', active: false }, 'remove-last-owner');
    expect(demoteLastOwner.statusCode).toBe(409);
    expect((await f.call('demo-owner', 'GET', `${prefix}/staff/accounts`)).statusCode).toBe(200);
    const audit = (await f.call('demo-owner', 'GET', `${prefix}/staff/audit`)).json();
    expect(audit.some((entry: { action: string }) => entry.action.includes('staff'))).toBe(true);
  });
});

describe('member presentation QR and local demo boundary', () => {
  it('requires staff authentication, verifies its signature, and expires at two minutes', async () => {
    const f = await fixture();
    const issued = await f.call('demo-customer', 'GET', `${prefix}/me/qr`);
    expect(issued.statusCode).toBe(200);
    const { qr } = issued.json();
    expect((await f.call('demo-customer', 'POST', `${prefix}/staff/resolve-qr`, { qr })).statusCode).toBe(403);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/resolve-qr`, { qr })).json().id).toBe(f.memberId);
    const tampered = qr.replace('tamaya-member:v1.', 'tamaya-member:v1.a');
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/resolve-qr`, { qr: tampered })).statusCode).toBe(400);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/resolve-qr`, { qr: 'tamaya-demo:v1:member_demo' })).statusCode).toBe(400);
    f.advance(120_000);
    expect((await f.call('demo-staff', 'POST', `${prefix}/staff/resolve-qr`, { qr })).statusCode).toBe(400);
  });

  it('serves the local sample page only in explicit demo mode and sends no-store headers', async () => {
    const demo = await fixture();
    expect((await demo.call(null, 'GET', '/demo')).headers['content-type']).toContain('text/html');
    expect((await demo.call(null, 'GET', '/')).body).toContain('試用画面');
    const normal = await fixture(createDemoVerifier(), false);
    expect((await normal.call(null, 'GET', '/demo')).statusCode).toBe(404);
    const own = await normal.call('demo-customer', 'GET', `${prefix}/me`);
    expect(own.headers['cache-control']).toBe('no-store');
  });

  it('blocks DNS-rebinding hosts and cross-origin access to local demo mutations', async () => {
    const f = await fixture();
    const url = `${prefix}/staff/members/${f.memberId}/stamps`;
    for (const headers of [
      { host: 'attacker.example:3001' },
      { host: '127.0.0.1:3001', origin: 'https://attacker.example' },
      { host: 'localhost:3001', origin: 'http://localhost:8081' },
      { host: 'localhost:3001', origin: 'null' },
    ]) {
      const reply = await f.app.inject({ method: 'POST', url, payload: {}, headers: {
        ...headers, authorization: 'Bearer demo-staff', 'idempotency-key': 'blocked-request',
      } });
      expect(reply.statusCode).toBe(403);
      expect(reply.json().error.code).toBe('LOCAL_DEMO_ONLY');
    }
    expect(f.db.getMember('tamaya', f.memberId).stamps).toBe(9);
    expect((await f.app.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' } })).statusCode).toBe(200);
  });
});
