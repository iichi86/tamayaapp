import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerDatabase } from '../src/database.js';
import { DomainError, type Identity, type Mutation } from '../src/types.js';

const owner: Identity = { uid: 'demo-owner', projectId: 'demo-tamaya' };
const staff: Identity = { uid: 'demo-staff', projectId: 'demo-tamaya' };
const customer: Identity = { uid: 'demo-customer', projectId: 'demo-tamaya' };
const visitor: Identity = { uid: 'new-customer', projectId: 'demo-tamaya' };
const operation = (key: string, actor = staff, fingerprint = key): Mutation => ({
  actor, idempotencyKey: key, fingerprint,
});

describe('durable server database', () => {
  let db: ServerDatabase;
  let now: Date;
  let memberId: string;
  let folder: string;
  let path: string;
  beforeEach(() => {
    now = new Date('2026-10-27T03:00:00.000Z');
    folder = mkdtempSync(join(tmpdir(), 'tamaya-server-db-'));
    path = join(folder, 'database.sqlite');
    db = new ServerDatabase(path, { now: () => now });
    memberId = db.seedDemo().memberId;
  });
  afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

  it('registers an authenticated member with zero stamps and preserves identity on repeated registration', () => {
    const first = db.registerMember('tamaya', visitor, 'たまやテスト');
    const second = db.registerMember('tamaya', visitor, '別の入力');
    expect(first.stamps).toBe(0);
    expect(first.coupons).toEqual([]);
    expect(second).toEqual(first);
    expect(db.getOwnMember('tamaya', visitor).id).toBe(first.id);
    expect(db.getOwnMember('tamaya', customer).id).toBe(memberId);
    expect(db.stats('tamaya').members).toBe(2);
  });

  it('checks project identity and prevents crossing store boundaries', () => {
    db.createStore({ id: 'other', name: '別の試験店', firebaseProjectId: 'demo-other', stampsRequired: 10, discountYen: 100, validityDays: 30 });
    expect(() => db.getOwnMember('other', customer)).toThrowError(expect.objectContaining({ code: 'PROJECT_MISMATCH' }));
    expect(() => db.getMember('other', memberId)).toThrowError(expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }));
    expect(() => db.grantStamp('other', memberId, operation('wrong-store'))).toThrowError(expect.objectContaining({ code: 'PROJECT_MISMATCH' }));
    expect(() => db.createStore({ id: 'tamaya', name: '変更', firebaseProjectId: 'different-project', stampsRequired: 10, discountYen: 100, validityDays: 30 }))
      .toThrowError(expect.objectContaining({ code: 'STORE_PROJECT_CONFLICT' }));
    expect(db.listMembers('other')).toEqual([]);
  });

  it('keeps staff privileges scoped to one store even when Firebase projects are shared', () => {
    db.createStore({ id: 'same-project-store', name: '同じ認証の別店舗', firebaseProjectId: 'demo-tamaya', stampsRequired: 10, discountYen: 100, validityDays: 30 });
    const otherMember = db.registerMember('same-project-store', customer, '別店舗の会員');
    expect(db.getStaff('same-project-store', staff)).toBeNull();
    expect(() => db.grantStamp('same-project-store', otherMember.id, operation('cross-store-staff')))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => db.getMember('tamaya', otherMember.id)).toThrowError(expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }));
    expect(db.getOwnMember('tamaya', customer).id).toBe(memberId);
    expect(db.getOwnMember('same-project-store', customer).id).toBe(otherMember.id);
  });

  it('seeds only explicit demo data with nine historical stamps and never resets changed data', () => {
    const before = db.getMember('tamaya', memberId);
    expect(before.stamps).toBe(9);
    expect(before.stampHistory).toHaveLength(9);
    expect(before.stampHistory.every((stamp) => stamp.japanDate < '2026-10-27')).toBe(true);
    expect(before.coupons.map((coupon) => coupon.status).sort()).toEqual(['expired', 'used']);
    expect(db.stats('tamaya')).toEqual({ members: 1, stampsToday: 0, redemptionsToday: 0 });
    db.grantStamp('tamaya', memberId, operation('once'));
    expect(db.seedDemo().memberId).toBe(memberId);
    expect(db.getMember('tamaya', memberId).stamps).toBe(0);
    expect(db.stats('tamaya').stampsToday).toBe(1);
  });

  it('atomically consumes the tenth stamp and issues one coupon with frozen conditions', () => {
    const result = db.grantStamp('tamaya', memberId, operation('tenth'));
    expect(result.member.stamps).toBe(0);
    expect(result.member.stampHistory).toHaveLength(10);
    expect(result.coupon).toMatchObject({ discountYen: 100, stampsRequired: 10, status: 'available' });
    expect(Date.parse(result.coupon!.expiresAt) - Date.parse(result.coupon!.issuedAt)).toBe(30 * 86_400_000);
    expect(result.member.coupons.filter((coupon) => coupon.status === 'available')).toHaveLength(1);
    expect(db.audit('tamaya', owner).filter((entry) => entry.action === 'stamp.grant')).toHaveLength(1);
  });

  it('replays the same completed operation, rejects a reused key for different input and blocks a second daily grant', () => {
    const first = db.grantStamp('tamaya', memberId, operation('request-1'));
    expect(db.grantStamp('tamaya', memberId, operation('request-1'))).toEqual(first);
    expect(() => db.grantStamp('tamaya', memberId, operation('request-1', staff, 'different-target')))
      .toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => db.grantStamp('tamaya', memberId, operation('request-2')))
      .toThrowError(expect.objectContaining({ code: 'ALREADY_STAMPED' }));
    expect(db.stats('tamaya').stampsToday).toBe(1);
  });

  it('protects simultaneous requests with different request IDs', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      Promise.resolve().then(() => db.grantStamp('tamaya', memberId, operation(`concurrent-${index}`)))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(19);
    expect(db.getMember('tamaya', memberId).coupons.filter((coupon) => coupon.status === 'available')).toHaveLength(1);
    expect(db.stats('tamaya').stampsToday).toBe(1);
  });

  it('uses the Japanese date boundary rather than the UTC calendar date', () => {
    const member = db.registerMember('tamaya', visitor, '日付テスト');
    now = new Date('2026-10-27T14:59:59.999Z');
    expect(db.grantStamp('tamaya', member.id, operation('before-midnight')).stamp.japanDate).toBe('2026-10-27');
    now = new Date('2026-10-27T15:00:00.000Z');
    expect(db.grantStamp('tamaya', member.id, operation('after-midnight')).stamp.japanDate).toBe('2026-10-28');
    expect(db.getMember('tamaya', member.id).stamps).toBe(2);
    expect(db.stats('tamaya').stampsToday).toBe(1);
    expect(() => db.grantStamp('tamaya', member.id, operation('same-new-day'))).toThrowError(expect.objectContaining({ code: 'ALREADY_STAMPED' }));
  });

  it('redeems a coupon once, safely retries it and refuses subsequent use', async () => {
    const coupon = db.grantStamp('tamaya', memberId, operation('issue')).coupon!;
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      Promise.resolve().then(() => db.redeemCoupon('tamaya', coupon.id, operation(`redeem-${index}`)))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const used = db.redeemCoupon('tamaya', coupon.id, operation('redeem-0'));
    expect(used.coupon.status).toBe('used');
    expect(used.coupon.usedAt).toBe(now.toISOString());
    expect(() => db.redeemCoupon('tamaya', coupon.id, operation('redeem-again'))).toThrowError(expect.objectContaining({ code: 'COUPON_USED' }));
    expect(db.stats('tamaya').redemptionsToday).toBe(1);
  });

  it('refuses expired coupons at the exact expiration instant and before issuance', () => {
    const coupon = db.grantStamp('tamaya', memberId, operation('issue')).coupon!;
    now = new Date(Date.parse(coupon.issuedAt) - 1);
    expect(() => db.redeemCoupon('tamaya', coupon.id, operation('too-early'))).toThrowError(expect.objectContaining({ code: 'COUPON_NOT_ACTIVE' }));
    now = new Date(coupon.expiresAt);
    expect(db.getMember('tamaya', memberId).coupons.find((item) => item.id === coupon.id)?.status).toBe('expired');
    expect(() => db.redeemCoupon('tamaya', coupon.id, operation('expired'))).toThrowError(expect.objectContaining({ code: 'COUPON_EXPIRED' }));
    expect(db.stats('tamaya').redemptionsToday).toBe(0);
  });

  it('keeps issued reward conditions when store settings change and the process restarts', () => {
    const original = db.grantStamp('tamaya', memberId, operation('original-issue')).coupon!;
    db.close();
    const sql = new DatabaseSync(path);
    sql.prepare('UPDATE stores SET discount_yen = 300, validity_days = 60 WHERE id = ?').run('tamaya');
    sql.close();
    db = new ServerDatabase(path, { now: () => now });
    expect(db.getMember('tamaya', memberId).coupons.find((coupon) => coupon.id === original.id)).toEqual(original);
    for (let index = 1; index <= 10; index += 1) {
      now = new Date(now.getTime() + 86_400_000);
      const result = db.grantStamp('tamaya', memberId, operation(`next-${index}`));
      if (index === 10) {
        expect(result.coupon!.discountYen).toBe(300);
        expect(Date.parse(result.coupon!.expiresAt) - Date.parse(result.coupon!.issuedAt)).toBe(60 * 86_400_000);
      }
    }
  });

  it('persists registration, history and idempotency receipts across restarts', () => {
    const registered = db.registerMember('tamaya', visitor, '再起動テスト');
    const result = db.grantStamp('tamaya', registered.id, operation('persist'));
    db.close();
    db = new ServerDatabase(path, { now: () => now });
    expect(db.getOwnMember('tamaya', visitor)).toEqual(result.member);
    expect(db.grantStamp('tamaya', registered.id, operation('persist'))).toEqual(result);
    expect(db.stats('tamaya')).toEqual({ members: 2, stampsToday: 1, redemptionsToday: 0 });
  });

  it('rolls back the event, balance, audit and receipt when issuing a coupon fails', () => {
    const sql = new DatabaseSync(path);
    sql.exec("CREATE TRIGGER refuse_coupon BEFORE INSERT ON coupons BEGIN SELECT RAISE(ABORT, 'simulated disk operation failure'); END;");
    expect(() => db.grantStamp('tamaya', memberId, operation('retry-after-failure'))).toThrow('simulated disk operation failure');
    expect(db.getMember('tamaya', memberId).stamps).toBe(9);
    expect(db.stats('tamaya').stampsToday).toBe(0);
    expect(db.audit('tamaya', owner).filter((entry) => entry.action === 'stamp.grant')).toHaveLength(0);
    sql.exec('DROP TRIGGER refuse_coupon');
    sql.close();
    expect(db.grantStamp('tamaya', memberId, operation('retry-after-failure')).coupon).not.toBeNull();
  });

  it('enforces daily uniqueness and cross-store references in SQLite itself', () => {
    const first = db.grantStamp('tamaya', memberId, operation('grant'));
    db.createStore({ id: 'other', name: '別店舗', firebaseProjectId: 'demo-other', stampsRequired: 10, discountYen: 100, validityDays: 30 });
    const sql = new DatabaseSync(path);
    sql.exec('PRAGMA foreign_keys = ON');
    const insert = sql.prepare(`INSERT INTO stamp_events(id, store_id, member_id, actor_uid, created_at, japan_date, source)
      VALUES (?, ?, ?, ?, ?, ?, 'visit')`);
    expect(() => insert.run('duplicate', 'tamaya', memberId, staff.uid, now.toISOString(), first.stamp.japanDate)).toThrow(/UNIQUE/);
    expect(() => insert.run('wrong-store', 'other', memberId, staff.uid, now.toISOString(), '2026-10-29')).toThrow(/FOREIGN KEY/);
    sql.close();
  });

  it('restricts staff management to owners, preserves the last owner, and rejects revoked staff even on replay', () => {
    expect(() => db.setStaff('tamaya', visitor.uid, 'owner', true, operation('self-promote', visitor))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => db.setStaff('tamaya', visitor.uid, 'owner', true, operation('staff-promote', staff))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => db.setStaff('tamaya', owner.uid, 'staff', true, operation('last-owner', owner))).toThrowError(expect.objectContaining({ code: 'LAST_OWNER' }));
    db.grantStamp('tamaya', memberId, operation('staff-operation'));
    const stopped = db.setStaff('tamaya', staff.uid, 'staff', false, operation('stop-staff', owner));
    expect(stopped.active).toBe(false);
    expect(db.getStaff('tamaya', staff)?.active).toBe(false);
    expect(() => db.grantStamp('tamaya', memberId, operation('staff-operation'))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(db.listStaff('tamaya', owner).some((entry) => entry.uid === staff.uid && !entry.active)).toBe(true);
    expect(() => db.audit('tamaya', staff)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('protects notice editing and keeps duplicate requests from adding another notice', () => {
    expect(() => db.saveNotice('tamaya', { title: '不正', body: '変更' }, operation('customer-notice', customer)))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    const input = { title: '本日のお知らせ', body: 'これは試験用の文章です。' };
    const result = db.saveNotice('tamaya', input, operation('create-notice'));
    expect(db.saveNotice('tamaya', input, operation('create-notice'))).toEqual(result);
    expect(db.listNotices('tamaya').filter((item) => item.id === result.id)).toHaveLength(1);
    expect(db.saveNotice('tamaya', { ...input, id: result.id, body: '編集しました。' }, operation('edit-notice')).body).toBe('編集しました。');
    expect(() => db.listStaff('tamaya', customer)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('validates inputs without creating partial member or mutation data', () => {
    expect(() => db.registerMember('tamaya', visitor, ' ')).toThrow(DomainError);
    expect(() => db.registerMember('tamaya', visitor, '長'.repeat(21))).toThrow(DomainError);
    expect(() => db.grantStamp('tamaya', memberId, operation('invalid key'))).toThrowError(expect.objectContaining({ code: 'INVALID_IDEMPOTENCY' }));
    expect(db.stats('tamaya')).toEqual({ members: 1, stampsToday: 0, redemptionsToday: 0 });
  });
});
