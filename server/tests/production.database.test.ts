import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresDatabase } from '../src/production/database.js';
import type { ProductionIdentity, ProductionMutation } from '../src/production/types.js';
import type { StoreInfo } from '../../shared/contracts.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('PostgreSQL production transactions (real database, independent connections)', () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 4 });
  let clock = new Date('2026-10-20T03:00:00.000Z');
  const db = new PostgresDatabase(admin, { now: () => clock });
  const other = new PostgresDatabase(new Pool({ connectionString: databaseUrl, max: 3 }), { now: () => clock });
  beforeAll(async () => { await db.migrate(); }, 30_000);
  afterAll(async () => { await db.close(); await other.close(); });
  const mutation = (actor: ProductionIdentity, fingerprint: string, key = randomUUID()): ProductionMutation => ({ actor, fingerprint, idempotencyKey: key });
  function identity(uid: string, projectId: string): ProductionIdentity {
    return { uid, projectId, emailVerified: true, authTime: clock.getTime() / 1000 };
  }
  async function fixture() {
    clock = new Date('2026-10-20T03:00:00.000Z');
    const id = `it-${randomUUID().slice(0, 12)}`;
    const projectId = `demo-${id}`;
    const store: StoreInfo = {
      id, name: '検証専用架空店舗', area: 'テスト', address: null, phone: null, hours: null, informationSource: null,
      products: [{ id: 'test', name: '検証用商品' }], operator: { name: '検証用', phone: '000', email: null },
      reward: { version: 'test-only-1', stampsRequired: 5, validityDays: 90, dailyLimit: 1, timeZone: 'Asia/Tokyo', minimumPurchaseYen: 500, redemptionMinimumPurchaseYen: 0,
        benefit: { kind: 'yen', value: 100, label: '検証用100円引き（本番条件ではありません）' },
        eligibleProducts: ['検証用商品'], combinationRule: '検証用併用不可', operationsEnabled: true },
      legal: { termsVersion: 'test-terms-1', privacyVersion: 'test-privacy-1', termsText: 'テスト', privacyText: 'テスト', supportText: 'テスト', privacyUrl: null, supportUrl: null },
    };
    const owner = identity(`owner-${id}`, projectId), staff = identity(`staff-${id}`, projectId), customer = identity(`customer-${id}`, projectId);
    await db.upsertStore(store, projectId);
    await db.bootstrapOwner(id, owner.uid);
    const input = { nickname: '架空の会員', acceptedTermsVersion: store.legal.termsVersion, acceptedPrivacyVersion: store.legal.privacyVersion };
    await db.register(id, staff, { ...input, nickname: '検証スタッフ' });
    await db.setStaff(id, staff.uid, 'staff', true, mutation(owner, 'add-staff'));
    const member = await db.register(id, customer, input);
    return { id, projectId, store, owner, staff, customer, member, input };
  }
  async function earnCoupon(f: Awaited<ReturnType<typeof fixture>>) {
    let coupon = null;
    for (let day = 0; day < 5; day++) {
      clock = new Date(`2026-10-${20 + day}T03:00:00.000Z`);
      coupon = (await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, `grant-${day}`))).coupon;
    }
    if (!coupon) throw new Error('Expected coupon');
    return coupon;
  }

  it('registers at zero, checks consent, and serializes concurrent registration', async () => {
    const f = await fixture();
    expect(f.member.stamps).toBe(0);
    const next = identity('second-registration', f.projectId);
    await expect(db.register(f.id, next, { ...f.input, acceptedTermsVersion: 'old' })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    const [a, b] = await Promise.all([db.register(f.id, next, f.input), other.register(f.id, next, { ...f.input, nickname: '別の名前' })]);
    expect(a.id).toBe(b.id);
    expect(a.stamps).toBe(0);
    expect((await db.stats(f.id, f.owner)).members).toBe(3);
  });

  it('consumes exactly five stamps and snapshots a 90-day coupon atomically', async () => {
    const f = await fixture();
    const coupon = await earnCoupon(f);
    const member = (await db.getMe(f.id, f.customer)).member!;
    expect(member.stamps).toBe(0);
    expect(member.stampHistory).toHaveLength(5);
    expect(member.coupons).toHaveLength(1);
    expect(new Date(coupon.expiresAt).getTime() - new Date(coupon.issuedAt).getTime()).toBe(90 * 86400_000);
    expect(coupon.benefit).toEqual(f.store.reward.benefit);
    expect(coupon.eligibleProducts).toEqual(['検証用商品']);
    expect(coupon.redemptionMinimumPurchaseYen).toBe(0);
    expect(member.stampHistory.every((s) => s.purchaseAmountYen === 500)).toBe(true);
  });

  it('requires at least 500 yen, records the amount, and rejects invalid numeric inputs without effects', async () => {
    const f = await fixture();
    for (const amount of [499, -1, 500.5, Number.NaN, Number.POSITIVE_INFINITY, 100000001, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(db.grantStamp(f.id, f.member.id, amount, mutation(f.staff, `invalid-${amount}`))).rejects.toMatchObject({ code: amount === 499 ? 'PURCHASE_TOO_SMALL' : 'INVALID_PURCHASE_AMOUNT' });
    }
    expect((await db.getMe(f.id, f.customer)).member?.stampHistory).toHaveLength(0);
    const result = await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'exact-minimum'));
    expect(result.member.stamps).toBe(1);
    expect(result.member.stampHistory[0].purchaseAmountYen).toBe(500);
    expect((await admin.query("SELECT purchase_amount_yen FROM tamaya.audit_log WHERE store_id=$1 AND action='stamp.grant'", [f.id])).rows[0].purchase_amount_yen).toBe(500);
  });

  it('issues a random fresh-sweet item benefit after five qualifying visits without inventing a discount value', async () => {
    const f = await fixture();
    f.store.reward = { ...f.store.reward, version: 'test-item-reward-2', benefit: { kind: 'item', label: '検証用・ランダムの生菓子お一つ' }, eligibleProducts: ['生菓子'] };
    await db.upsertStore(f.store, f.projectId);
    const coupon = await earnCoupon(f);
    expect(coupon.benefit).toEqual({ kind: 'item', label: '検証用・ランダムの生菓子お一つ' });
    expect('value' in coupon.benefit).toBe(false);
    expect(coupon.eligibleProducts).toEqual(['生菓子']);
    expect((await db.getMe(f.id, f.customer)).member?.stamps).toBe(0);
    expect(new Date(coupon.expiresAt).getTime() - new Date(coupon.issuedAt).getTime()).toBe(90 * 86400_000);
  });

  it('prevents different-key concurrent grants across separate pools', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([
      db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'grant-a')),
      other.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'grant-b')),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'ALREADY_STAMPED' } });
    expect((await db.getMe(f.id, f.customer)).member?.stamps).toBe(1);
    expect((await db.stats(f.id, f.owner)).stampsToday).toBe(1);
  });

  it('replays equal concurrent idempotency keys once, rejects changed payloads, and rechecks revoked staff', async () => {
    const f = await fixture();
    const m = mutation(f.staff, 'same-grant');
    const [a, b] = await Promise.all([db.grantStamp(f.id, f.member.id, 500, m), other.grantStamp(f.id, f.member.id, 500, m)]);
    expect(a).toEqual(b);
    expect(a.member.stampHistory).toHaveLength(1);
    const receipt = (await admin.query('SELECT response FROM tamaya.idempotency WHERE store_id=$1 AND key=$2', [f.id, m.idempotencyKey])).rows[0].response;
    expect(receipt).toEqual({ format: 'member-effect-v1', couponId: null });
    expect(JSON.stringify(receipt)).not.toContain(f.member.nickname);
    await expect(db.grantStamp(f.id, f.member.id, 500, { ...m, fingerprint: 'different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await db.setStaff(f.id, f.staff.uid, 'staff', false, mutation(f.owner, 'stop-staff'));
    await expect(other.grantStamp(f.id, f.member.id, 500, m)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('uses Japan dates at the midnight boundary', async () => {
    const f = await fixture();
    clock = new Date('2026-10-20T14:59:59.999Z');
    await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'before-midnight'));
    clock = new Date('2026-10-20T15:00:00.000Z');
    const next = await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'after-midnight'));
    expect(next.member.stamps).toBe(2);
    expect(next.member.stampHistory.map((s) => s.japanDate)).toEqual(['2026-10-21', '2026-10-20']);
  });

  it('allows one concurrent redemption, records it once, and rejects reuse', async () => {
    const f = await fixture(), coupon = await earnCoupon(f);
    const attempts = await Promise.allSettled([
      db.redeemCoupon(f.id, coupon.id, 0, mutation(f.staff, 'redeem-a')),
      other.redeemCoupon(f.id, coupon.id, 0, mutation(f.staff, 'redeem-b')),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'COUPON_USED' } });
    expect((await db.stats(f.id, f.owner)).redemptionsToday).toBe(1);
    expect((await db.getMe(f.id, f.customer)).member?.coupons[0].status).toBe('used');
  });

  it('rejects redemption at the exact expiry instant', async () => {
    const f = await fixture(), coupon = await earnCoupon(f);
    clock = new Date(coupon.expiresAt);
    await expect(db.redeemCoupon(f.id, coupon.id, 0, mutation(f.staff, 'expired'))).rejects.toMatchObject({ code: 'COUPON_EXPIRED' });
    expect((await db.getMe(f.id, f.customer)).member?.coupons[0].status).toBe('expired');
  });

  it('keeps issued coupon terms after changing future policy', async () => {
    const f = await fixture(), coupon = await earnCoupon(f);
    f.store.reward = { ...f.store.reward, version: 'test-only-2', benefit: { kind: 'percent', value: 10, label: '検証用10％引き' }, combinationRule: '変更後の検証条件', redemptionMinimumPurchaseYen: 500 };
    await db.upsertStore(f.store, f.projectId);
    const result = await db.redeemCoupon(f.id, coupon.id, 0, mutation(f.staff, 'old-policy-coupon'));
    expect(result.coupon.benefit).toEqual(coupon.benefit);
    expect(result.coupon.combinationRule).toBe('検証用併用不可');
    expect(result.coupon.policyVersion).toBe('test-only-1');
    expect(result.coupon.redemptionMinimumPurchaseYen).toBe(0);
  });

  it('enforces the issued coupon minimum and records the redemption purchase amount', async () => {
    const f = await fixture();
    f.store.reward = { ...f.store.reward, version: 'test-redemption-minimum-2', redemptionMinimumPurchaseYen: 500 };
    await db.upsertStore(f.store, f.projectId);
    const coupon = await earnCoupon(f);
    expect(coupon.redemptionMinimumPurchaseYen).toBe(500);
    await expect(db.redeemCoupon(f.id, coupon.id, 499, mutation(f.staff, 'redeem-under-minimum'))).rejects.toMatchObject({ code: 'PURCHASE_TOO_SMALL' });
    expect((await db.getMe(f.id, f.customer)).member?.coupons[0].status).toBe('available');
    const used = await db.redeemCoupon(f.id, coupon.id, 500, mutation(f.staff, 'redeem-at-minimum'));
    expect(used.coupon.status).toBe('used');
    expect((await admin.query('SELECT used_purchase_amount_yen FROM tamaya.coupons WHERE id=$1', [coupon.id])).rows[0].used_purchase_amount_yen).toBe(500);
    expect((await admin.query("SELECT purchase_amount_yen FROM tamaya.audit_log WHERE store_id=$1 AND action='coupon.redeem'", [f.id])).rows[0].purchase_amount_yen).toBe(500);
  });

  it('fails closed until formal benefit and combination conditions are set', async () => {
    const f = await fixture();
    f.store.reward = { ...f.store.reward, version: 'pending-2', benefit: null, combinationRule: null, operationsEnabled: false };
    await db.upsertStore(f.store, f.projectId);
    await expect(db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'pending'))).rejects.toMatchObject({ code: 'RULES_NOT_READY' });
    expect((await db.getMe(f.id, f.customer)).member?.stamps).toBe(0);
  });

  it('rolls back stamp, balance, audit and receipt if coupon insertion fails', async () => {
    const f = await fixture();
    for (let day = 0; day < 4; day++) {
      clock = new Date(`2026-10-${20 + day}T03:00:00.000Z`);
      await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, `pre-${day}`));
    }
    clock = new Date('2026-10-24T03:00:00.000Z');
    const fn = `it_fail_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE FUNCTION tamaya.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.store_id='${f.id}' THEN RAISE EXCEPTION 'injected test failure'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON tamaya.coupons FOR EACH ROW EXECUTE FUNCTION tamaya.${fn}()`);
    const m = mutation(f.staff, 'rollback');
    try { await expect(db.grantStamp(f.id, f.member.id, 500, m)).rejects.toThrow('injected test failure'); }
    finally { await admin.query(`DROP TRIGGER ${fn} ON tamaya.coupons`); await admin.query(`DROP FUNCTION tamaya.${fn}()`); }
    const member = (await db.getMe(f.id, f.customer)).member!;
    expect(member.stamps).toBe(4); expect(member.stampHistory).toHaveLength(4); expect(member.coupons).toHaveLength(0);
    expect((await admin.query('SELECT 1 FROM tamaya.idempotency WHERE store_id=$1 AND key=$2', [f.id, m.idempotencyKey])).rowCount).toBe(0);
    expect((await db.grantStamp(f.id, f.member.id, 500, m)).member.stamps).toBe(0);
  });

  it('rejects foreign projects, unverified customers and customer staff access', async () => {
    const f = await fixture();
    await expect(db.getMe(f.id, { ...f.customer, projectId: 'other-project' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(db.getMe(f.id, { ...f.customer, emailVerified: false })).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await expect(db.getMember(f.id, f.member.id, f.customer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(db.setStaff(f.id, f.customer.uid, 'owner', true, mutation(f.staff, 'self-promote'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('scopes member lookup to store and never enumerates all members with a blank query', async () => {
    const f = await fixture(), secondId = `${f.id}-b`;
    await db.upsertStore({ ...f.store, id: secondId }, f.projectId);
    await db.bootstrapOwner(secondId, f.owner.uid);
    await expect(db.getMember(secondId, f.member.id, f.owner)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    expect(await db.listMembers(f.id, '', f.staff)).toEqual([]);
    expect(await db.listMembers(f.id, '%', f.staff)).toEqual([]);
    expect(await db.listMembers(f.id, f.member.number, f.staff)).toMatchObject([{ id: f.member.id }]);
    expect(await db.listMembers(secondId, f.member.number, f.owner)).toEqual([]);
  });

  it('prevents the last owner from being stopped, even with concurrent owner changes', async () => {
    const f = await fixture();
    await expect(db.setStaff(f.id, f.owner.uid, 'staff', false, mutation(f.owner, 'last-owner'))).rejects.toMatchObject({ code: 'LAST_OWNER' });
    const secondOwner = identity(`second-${f.id}`, f.projectId);
    await db.register(f.id, secondOwner, { ...f.input, nickname: '検証オーナー2' });
    await db.setStaff(f.id, secondOwner.uid, 'owner', true, mutation(f.owner, 'second-owner'));
    const attempts = await Promise.allSettled([
      db.setStaff(f.id, secondOwner.uid, 'staff', false, mutation(f.owner, 'demote-b')),
      other.setStaff(f.id, f.owner.uid, 'staff', false, mutation(secondOwner, 'demote-a')),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const actor = (attempts[0].status === 'fulfilled') ? f.owner : secondOwner;
    expect((await db.listStaff(f.id, actor)).filter((s) => s.role === 'owner' && s.active)).toHaveLength(1);
  });

  it('refuses phantom staff/owner activation and never stops a real owner through a nonexistent handover', async () => {
    const f = await fixture();
    await expect(db.setStaff(f.id, 'not-a-registered-user', 'owner', true, mutation(f.owner, 'phantom-owner'))).rejects.toMatchObject({ code: 'STAFF_MEMBER_REQUIRED' });
    await expect(db.setStaff(f.id, f.owner.uid, 'staff', false, mutation(f.owner, 'stop-after-phantom'))).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(db.setStaff(f.id, 'not-a-registered-user', 'staff', false, mutation(f.owner, 'stop-unknown'))).rejects.toMatchObject({ code: 'STAFF_NOT_FOUND' });
  });

  it('persists notices and computes statistics from records after reconnecting', async () => {
    const f = await fixture();
    const notice = await db.saveNotice(f.id, { title: '検証', body: '永続保存' }, mutation(f.staff, 'notice-add'));
    await other.saveNotice(f.id, { id: notice.id, title: '検証・更新', body: '別の接続から更新' }, mutation(f.staff, 'notice-update'));
    await db.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'persist-stamp'));
    const reopened = new PostgresDatabase(new Pool({ connectionString: databaseUrl }), { now: () => clock });
    try {
      expect((await reopened.listNotices(f.id))[0].title).toBe('検証・更新');
      expect((await reopened.getMe(f.id, f.customer)).member?.stamps).toBe(1);
      expect(await reopened.stats(f.id, f.owner)).toEqual({ members: 2, stampsToday: 1, redemptionsToday: 0 });
      expect((await reopened.audit(f.id, f.owner)).some((a) => a.action === 'stamp.grant')).toBe(true);
    } finally { await reopened.close(); }
  });

  it('marks deletion pending, resumes cleanup, removes personal data and preserves anonymous counts', async () => {
    const f = await fixture();
    const grant = mutation(f.staff, 'deletion-setup');
    await db.grantStamp(f.id, f.member.id, 500, grant);
    await expect(db.requestDeletion(f.id, { ...f.customer, authTime: clock.getTime() / 1000 - 301 })).rejects.toMatchObject({ code: 'RECENT_LOGIN_REQUIRED' });
    expect(await db.requestDeletion(f.id, f.customer)).toEqual({ status: 'pending' });
    await expect(db.getMe(f.id, f.customer)).rejects.toMatchObject({ code: 'ACCOUNT_DELETING' });
    await expect(db.getMember(f.id, f.member.id, f.staff)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    await expect(other.grantStamp(f.id, f.member.id, 500, grant)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    const job = (await other.pendingDeletions()).find((j) => j.uid === f.customer.uid)!;
    expect(job.projectId).toBe(f.projectId);
    await other.completeDeletion(job.id);
    await db.completeDeletion(job.id); // completion is safe after process retry
    expect((await db.getMe(f.id, f.customer)).member).toBeNull();
    expect(await db.stats(f.id, f.owner)).toEqual({ members: 1, stampsToday: 1, redemptionsToday: 0 });
    expect((await admin.query('SELECT 1 FROM tamaya.members WHERE uid=$1', [f.customer.uid])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM tamaya.idempotency WHERE store_id=$1 AND response::text LIKE $2', [f.id, `%${f.member.nickname}%`])).rowCount).toBe(0);
    expect((await admin.query('SELECT uid,state FROM tamaya.deletion_jobs WHERE id=$1', [job.id])).rows[0]).toEqual({ uid: null, state: 'completed' });
  });

  it('requires staff revocation before account deletion and blocks reactivation while deleting', async () => {
    const f = await fixture();
    await expect(db.requestDeletion(f.id, f.staff)).rejects.toMatchObject({ code: 'STAFF_ACCOUNT_ACTIVE' });
    const stop = mutation(f.owner, 'staff-revoke-for-delete');
    await db.setStaff(f.id, f.staff.uid, 'staff', false, stop);
    await db.requestDeletion(f.id, f.staff);
    await expect(db.setStaff(f.id, f.staff.uid, 'staff', true, mutation(f.owner, 'reactivate-deleting'))).rejects.toMatchObject({ code: 'ACCOUNT_DELETING' });
    const job = (await db.pendingDeletions()).find((j) => j.uid === f.staff.uid)!;
    await db.completeDeletion(job.id);
    expect((await admin.query('SELECT 1 FROM tamaya.idempotency WHERE store_id=$1 AND response->>\'uid\'=$2', [f.id, f.staff.uid])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM tamaya.audit_log WHERE store_id=$1 AND (actor_uid=$2 OR target_id=$2)', [f.id, f.staff.uid])).rowCount).toBe(0);
    await expect(other.setStaff(f.id, f.staff.uid, 'staff', false, stop)).rejects.toMatchObject({ code: 'STAFF_NOT_FOUND' });
  });

  it('lets an unverified signup delete its identity without creating a phantom membership', async () => {
    const f = await fixture();
    const unverified = { ...identity(`unverified-${f.id}`, f.projectId), emailVerified: false };
    expect(await db.requestDeletion(f.id, unverified)).toEqual({ status: 'pending' });
    expect((await admin.query('SELECT 1 FROM tamaya.members WHERE store_id=$1 AND uid=$2', [f.id, unverified.uid])).rowCount).toBe(0);
    const job = (await db.pendingDeletions()).find((j) => j.uid === unverified.uid)!;
    expect(job).toBeTruthy();
    await db.completeDeletion(job.id);
  });

  it('does not replay a redemption snapshot while deletion waits for Firebase cleanup', async () => {
    const f = await fixture(), coupon = await earnCoupon(f);
    const m = mutation(f.staff, 'redeem-before-delete');
    await db.redeemCoupon(f.id, coupon.id, 0, m);
    await db.requestDeletion(f.id, { ...f.customer, authTime: clock.getTime() / 1000 });
    await expect(other.redeemCoupon(f.id, coupon.id, 0, m)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    const job = (await db.pendingDeletions()).find((j) => j.uid === f.customer.uid)!;
    await db.completeDeletion(job.id);
  });

  it('checks deletion status beyond the worker batch and filters projects before its limit', async () => {
    const f = await fixture();
    for (let i = 0; i < 21; i++) {
      await db.requestDeletion(f.id, { ...identity(`queued-${f.id}-${i}`, f.projectId), emailVerified: false });
    }
    const batch = await db.pendingDeletions(f.projectId);
    expect(batch).toHaveLength(20);
    expect(batch.every((job) => job.projectId === f.projectId)).toBe(true);
    expect(await db.deletionStatus(f.projectId, `queued-${f.id}-20`)).toBe('pending');
    const otherProject = await fixture();
    await db.requestDeletion(otherProject.id, otherProject.customer);
    const otherBatch = await db.pendingDeletions(otherProject.projectId);
    expect(otherBatch).toHaveLength(1);
    expect(otherBatch[0].uid).toBe(otherProject.customer.uid);
    for (const job of [...batch, ...otherBatch]) await db.completeDeletion(job.id);
    for (const job of await db.pendingDeletions(f.projectId)) await db.completeDeletion(job.id);
  });

  it('denies anonymous SQL access and permits only the private server role', async () => {
    const client = await admin.connect();
    try {
      await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$");
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE anon');
      await expect(client.query('SELECT * FROM tamaya.members')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE tamaya_api');
      expect((await client.query('SELECT count(*)::int AS count FROM tamaya.stores')).rows[0].count).toBeGreaterThan(0);
      await expect(client.query('CREATE TABLE tamaya.should_not_exist(id int)')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('runs membership and stamp operations with the non-bypass server role', async () => {
    const f = await fixture();
    const runtime = new PostgresDatabase(new Pool({ connectionString: databaseUrl, options: '-c role=tamaya_api' }), { now: () => clock });
    try {
      expect((await runtime.getMe(f.id, f.customer)).member?.id).toBe(f.member.id);
      expect((await runtime.grantStamp(f.id, f.member.id, 500, mutation(f.staff, 'least-privilege-grant'))).member.stamps).toBe(1);
      expect((await runtime.stats(f.id, f.owner)).stampsToday).toBe(1);
    } finally { await runtime.close(); }
  });
});
