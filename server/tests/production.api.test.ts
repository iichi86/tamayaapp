import { describe, expect, it, vi } from 'vitest';
import { createProductionApp, processDeletionJobs } from '../src/production/app.js';
import type { ProductionDatabasePort, ProductionIdentity, ProductionVerifier } from '../src/production/types.js';
import type { StoreInfo, ServerMember } from '../../shared/contracts.js';
const actor: ProductionIdentity = { uid: 'customer', projectId: 'test-project', emailVerified: true, authTime: 1_800_000_000 };
const now = () => new Date(1_800_000_000_000);
const store = { id: 'tamaya', name: 'むさしの玉屋', operator: { name: 'ワンエイト', phone: '080-4909-7012' }, legal: { privacyText: '<script>invalid</script>', termsText: '会員規約', supportText: 'お問い合わせください。' } } as StoreInfo;
const member: ServerMember = { id: 'member1', number: 'T000001', nickname: '架空の会員', stamps: 4, createdAt: now().toISOString(), stampHistory: [], coupons: [] };
function setup() {
  const db: ProductionDatabasePort = {
    getStore: vi.fn(async () => store), getMe: vi.fn(async () => ({ member, staff: null })), getStaff: vi.fn(async () => null),
    register: vi.fn(async () => member), updateNickname: vi.fn(async () => member), getMember: vi.fn(async () => member), listMembers: vi.fn(async () => [member]),
    grantStamp: vi.fn(async () => ({ member: { ...member, stamps: 0 }, coupon: null })), redeemCoupon: vi.fn(),
    listNotices: vi.fn(async () => []), saveNotice: vi.fn(), stats: vi.fn(async () => ({ members: 1, stampsToday: 0, redemptionsToday: 0 })),
    listStaff: vi.fn(async () => []), setStaff: vi.fn(), audit: vi.fn(async () => []), requestDeletion: vi.fn(async () => ({ status: 'pending' as const })),
    pendingDeletions: vi.fn(async () => []), deletionStatus: vi.fn(async () => 'completed' as const), completeDeletion: vi.fn(), close: vi.fn(),
  };
  const verifier: ProductionVerifier = { verify: vi.fn(async () => actor), deleteUser: vi.fn(async () => {}), verifyStaffUid: vi.fn(async () => {}) };
  const options = { db, verifier, projectId: 'test-project', storeId: 'tamaya', qrSecret: 'test-secret-with-32-random-characters', now };
  return { db, verifier, options };
}
const path = '/v1/stores/tamaya';
const headers = { authorization: 'Bearer test-token', 'idempotency-key': 'action-001' };
describe('production API boundary', () => {
  it('returns a retryable 429 for a shared-IP burst instead of disguising it as a server error', async () => {
    const { options } = setup(); const app = await createProductionApp(options);
    for (let index = 0; index < 600; index++) expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    const limited = await app.inject({ url: '/health' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });
  it('serves store/legal without exposing HTML supplied by store configuration', async () => {
    const { options } = setup(); const app = await createProductionApp(options);
    expect((await app.inject({ url: path })).json().name).toBe(store.name);
    const page = await app.inject({ url: '/privacy' }); expect(page.statusCode).toBe(200);
    expect(page.body).toContain('&lt;script&gt;invalid&lt;/script&gt;'); expect(page.body).not.toContain('<script>');
    expect(page.headers['cache-control']).toBe('no-store'); expect(page.headers['x-frame-options']).toBe('DENY');
    expect((await app.inject({ url: '/v1/stores/another' })).statusCode).toBe(404); await app.close();
  });
  it('rejects absent login, wrong project and unverified email before loading member data', async () => {
    const { options, verifier, db } = setup(); const app = await createProductionApp(options);
    expect((await app.inject({ url: `${path}/me` })).statusCode).toBe(401);
    vi.mocked(verifier.verify).mockResolvedValueOnce({ ...actor, projectId: 'other-project' });
    expect((await app.inject({ url: `${path}/me`, headers })).statusCode).toBe(401);
    vi.mocked(verifier.verify).mockResolvedValueOnce({ ...actor, emailVerified: false });
    expect((await app.inject({ url: `${path}/me`, headers })).statusCode).toBe(403);
    expect(db.getMe).not.toHaveBeenCalled(); await app.close();
  });
  it('never accepts a customer supplied role and checks live staff permission', async () => {
    const { options, db } = setup(); const app = await createProductionApp(options);
    expect((await app.inject({ method: 'POST', url: `${path}/staff/members/member1/stamps`, headers, payload: { purchaseAmountYen: 500 } })).statusCode).toBe(403);
    expect(db.grantStamp).not.toHaveBeenCalled(); vi.mocked(db.getStaff).mockResolvedValue({ uid: actor.uid, role: 'staff', active: true });
    expect((await app.inject({ method: 'POST', url: `${path}/staff/members/member1/stamps`, headers, payload: { purchaseAmountYen: 500, role: 'owner' } })).statusCode).toBe(400);
    expect((await app.inject({ url: `${path}/owner/staff`, headers })).statusCode).toBe(403); await app.close();
  });
  it('requires an operation key and fingerprints target/body at the server', async () => {
    const { options, db } = setup(); vi.mocked(db.getStaff).mockResolvedValue({ uid: actor.uid, role: 'staff', active: true }); const app = await createProductionApp(options);
    expect((await app.inject({ method: 'POST', url: `${path}/staff/members/member1/stamps`, headers: { authorization: headers.authorization }, payload: { purchaseAmountYen: 500 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${path}/staff/members/member1/stamps`, headers, payload: { purchaseAmountYen: 500 } })).statusCode).toBe(200);
    expect(db.grantStamp).toHaveBeenCalledWith('tamaya', 'member1', 500, { actor, idempotencyKey: 'action-001', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }); await app.close();
  });
  it('only resolves a signed unexpired QR for an authorized staff member', async () => {
    const { options, db } = setup(); const app = await createProductionApp(options); const qr = (await app.inject({ url: `${path}/me/qr`, headers })).json().qr;
    expect((await app.inject({ method: 'POST', url: `${path}/staff/resolve-qr`, headers, payload: { qr } })).statusCode).toBe(403);
    vi.mocked(db.getStaff).mockResolvedValue({ uid: actor.uid, role: 'staff', active: true });
    expect((await app.inject({ method: 'POST', url: `${path}/staff/resolve-qr`, headers, payload: { qr } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${path}/staff/resolve-qr`, headers, payload: { qr: `${qr}x` } })).statusCode).toBe(400);
    expect(db.getMember).toHaveBeenCalledWith('tamaya', 'member1', actor); await app.close();
  });
  it('requires fresh reauthentication before requesting resumable account deletion', async () => {
    const { options, db, verifier } = setup(); const app = await createProductionApp(options);
    vi.mocked(verifier.verify).mockResolvedValueOnce({ ...actor, authTime: actor.authTime - 301 });
    expect((await app.inject({ method: 'DELETE', url: `${path}/me`, headers, payload: { confirmation: '退会する' } })).statusCode).toBe(401); expect(db.requestDeletion).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'DELETE', url: `${path}/me`, headers, payload: { confirmation: '退会する' } })).json()).toEqual({ status: 'completed' });
    expect(db.requestDeletion).toHaveBeenCalledWith('tamaya', actor); await app.close();
  });
  it('lets an unverified new account delete itself without permitting registration', async () => {
    const { options, db, verifier } = setup();
    vi.mocked(verifier.verify).mockResolvedValue({ ...actor, emailVerified: false });
    const app = await createProductionApp(options);
    expect((await app.inject({ method: 'POST', url: `${path}/me/register`, headers, payload: { nickname: '新規', acceptedTermsVersion: '1', acceptedPrivacyVersion: '1' } })).statusCode).toBe(403);
    expect(db.register).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'DELETE', url: `${path}/me`, headers, payload: { confirmation: '退会する' } })).statusCode).toBe(200);
    expect(verifier.verify).toHaveBeenLastCalledWith('test-token', { allowUnverified: true });
    expect(db.requestDeletion).toHaveBeenCalledWith('tamaya', { ...actor, emailVerified: false });
    await app.close();
  });
  it('reports pending instead of pretending both deletion systems succeeded', async () => {
    const { options, db, verifier } = setup(); vi.mocked(db.pendingDeletions).mockResolvedValue([{ id: 'deletion1', uid: actor.uid, projectId: actor.projectId }]);
    vi.mocked(verifier.deleteUser).mockRejectedValue(new Error('private upstream error')); vi.mocked(db.deletionStatus).mockResolvedValue('pending'); const app = await createProductionApp(options);
    const response = await app.inject({ method: 'DELETE', url: `${path}/me`, headers, payload: { confirmation: '退会する' } });
    expect(response.statusCode).toBe(202); expect(response.json()).toEqual({ status: 'pending' }); expect(db.completeDeletion).not.toHaveBeenCalled();
    vi.mocked(verifier.deleteUser).mockResolvedValue(); expect(await processDeletionJobs(db, verifier, actor.projectId)).toEqual({ completed: 1, failed: 0 });
    expect(db.completeDeletion).toHaveBeenCalledWith('deletion1'); await app.close();
  });
  it('checks the requested deletion directly even when it is outside a worker batch', async () => {
    const { options, db } = setup();
    vi.mocked(db.pendingDeletions).mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: `older-${i}`, uid: `older-user-${i}`, projectId: actor.projectId })));
    vi.mocked(db.deletionStatus).mockResolvedValue('pending');
    const app = await createProductionApp(options);
    const response = await app.inject({ method: 'DELETE', url: `${path}/me`, headers, payload: { confirmation: '退会する' } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'pending' });
    expect(db.deletionStatus).toHaveBeenCalledWith(actor.projectId, actor.uid);
    expect(db.pendingDeletions).toHaveBeenCalledWith(actor.projectId);
    await app.close();
  });
  it('does not delete a UID for another Firebase project and reports readiness failure safely', async () => {
    const { options, db, verifier } = setup(); vi.mocked(db.pendingDeletions).mockResolvedValue([{ id: 'wrong', uid: actor.uid, projectId: 'other-project' }]);
    expect(await processDeletionJobs(db, verifier, actor.projectId)).toEqual({ completed: 0, failed: 1 }); expect(verifier.deleteUser).not.toHaveBeenCalled();
    vi.mocked(db.getStore).mockRejectedValue(new Error('postgres://secret')); const app = await createProductionApp(options);
    const health = await app.inject({ url: '/health' }); expect(health.statusCode).toBe(503); expect(health.body).not.toContain('secret'); await app.close();
  });
  it('rejects browser DNS rebinding and untrusted origins in local emulator mode', async () => {
    const { options } = setup(); const app = await createProductionApp({ ...options, localOnly: true });
    expect((await app.inject({ url: '/health', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/health', headers: { host: 'localhost:3001', origin: 'https://attacker.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/health', headers: { host: 'localhost:3001', origin: 'http://localhost:3001' } })).statusCode).toBe(200); await app.close();
  });
  it('ignores spoofed forwarded IPs unless the configured bounded proxy hop is trusted', async () => {
    const { options } = setup();
    const direct = await createProductionApp(options);
    direct.get('/test-client-ip', (request) => ({ ip: request.ip }));
    expect((await direct.inject({ url: '/test-client-ip', headers: { 'x-forwarded-for': '203.0.113.10' } })).json()).toEqual({ ip: '127.0.0.1' });
    await direct.close();
    const proxied = await createProductionApp({ ...options, trustProxyHops: 1 });
    proxied.get('/test-client-ip', (request) => ({ ip: request.ip }));
    expect((await proxied.inject({ url: '/test-client-ip', headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20' } })).json()).toEqual({ ip: '198.51.100.20' });
    await proxied.close();
  });
  it('checks the actual Firebase account before activating staff or handing over ownership', async () => {
    const { options, db, verifier } = setup();
    vi.mocked(db.getStaff).mockResolvedValue({ uid: actor.uid, role: 'owner', active: true });
    vi.mocked(verifier.verifyStaffUid).mockRejectedValue(new Error('Unknown user'));
    const app = await createProductionApp(options);
    const response = await app.inject({ method: 'PUT', url: `${path}/owner/staff/phantom`, headers, payload: { role: 'owner', active: true } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(verifier.verifyStaffUid).toHaveBeenCalledWith('phantom');
    expect(db.setStaff).not.toHaveBeenCalled();
    await app.close();
  });
  it('permits authenticated mutation preflights including DELETE, PATCH and PUT', async () => {
    const { options } = setup();
    const app = await createProductionApp({ ...options, allowedOrigins: ['https://members.example.com'] });
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const response = await app.inject({ method: 'OPTIONS', url: `${path}/me`, headers: {
        origin: 'https://members.example.com', 'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      } });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://members.example.com');
      expect(response.headers['access-control-allow-methods']).toContain(method);
      expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key');
    }
    await app.close();
  });
  it('rejects missing, fractional and negative purchase amounts before invoking stamp logic', async () => {
    const { options, db } = setup();
    vi.mocked(db.getStaff).mockResolvedValue({ uid: actor.uid, role: 'staff', active: true });
    const app = await createProductionApp(options);
    for (const payload of [{}, { purchaseAmountYen: -1 }, { purchaseAmountYen: 500.5 }, { purchaseAmountYen: '500' }]) {
      expect((await app.inject({ method: 'POST', url: `${path}/staff/members/member1/stamps`, headers, payload })).statusCode).toBe(400);
    }
    expect(db.grantStamp).not.toHaveBeenCalled(); await app.close();
  });
  it('does not leak driver errors in API responses', async () => {
    const { options, db } = setup(); vi.mocked(db.getMe).mockRejectedValue(new Error('DATABASE_URL=secret'));
    const app = await createProductionApp(options); const response = await app.inject({ url: `${path}/me`, headers });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('DATABASE_URL'); await app.close();
  });
});
