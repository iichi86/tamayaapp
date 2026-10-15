import { describe, expect, it, vi } from 'vitest';
import { createDemoData, grantStamp, redeemCoupon, registerMember, saveNotice } from '../src/domain/logic';
import type { DemoData, StorageAdapter } from '../src/domain/types';
import { DemoRepository } from '../src/storage/DemoRepository';

const NOW = new Date('2026-10-14T02:00:00.000Z');

class MemoryStorage implements StorageAdapter {
  raw: string | null = null;
  reads = 0;
  writes = 0;
  failWrite = false;
  holdWrite: Promise<void> | null = null;

  async read(): Promise<DemoData | null> {
    this.reads += 1;
    return this.raw === null ? null : JSON.parse(this.raw) as DemoData;
  }

  async write(data: DemoData): Promise<void> {
    this.writes += 1;
    if (this.holdWrite) await this.holdWrite;
    if (this.failWrite) throw new Error('disk full');
    this.raw = JSON.stringify(data);
  }
}

const repository = (storage: StorageAdapter) => new DemoRepository(storage, { now: () => NOW });

describe('demo repository persistence', () => {
  it('seeds only once and reloads registration, selected member, stamps, coupons, and edited notices', async () => {
    const storage = new MemoryStorage();
    const first = repository(storage);
    const seeded = await first.load();
    expect(storage.writes).toBe(1);
    expect(await first.load()).toBe(seeded);
    expect(storage.reads).toBe(1);
    await first.transact((data) => grantStamp(data, 'member_demo', NOW));
    await first.transact((data) => redeemCoupon(data, data.coupons[2].id, NOW));
    await first.transact((data) => saveNotice(data, { id: data.notices[0].id, title: '保存した題名', body: '保存した本文' }, NOW));
    const saved = await first.transact((data) => registerMember(data, '新しい会員', NOW));
    const second = repository(storage);
    expect(await second.load()).toEqual(saved);
    expect(storage.writes).toBe(5);
    expect(second.getSnapshot()?.members[1].stamps).toBe(0);
    expect(second.getSnapshot()?.currentMemberId).toBe(saved.members[1].id);
  });

  it('serializes rapid tenth-stamp requests so only one coupon is issued', async () => {
    const storage = new MemoryStorage();
    const repo = repository(storage);
    await repo.load();
    const requests = await Promise.allSettled([
      repo.transact((data) => grantStamp(data, 'member_demo', NOW)),
      repo.transact((data) => grantStamp(data, 'member_demo', NOW)),
      repo.transact((data) => grantStamp(data, 'member_demo', NOW)),
    ]);
    expect(requests.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(repo.getSnapshot()?.stamps).toHaveLength(10);
    expect(repo.getSnapshot()?.coupons).toHaveLength(3);
    expect(repo.getSnapshot()?.members[0].stamps).toBe(0);
    expect(storage.writes).toBe(2);
  });

  it('preserves historical coupon deadlines while new coupons use the current validity period', async () => {
    const storage = new MemoryStorage();
    const data = createDemoData(NOW);
    const historicalCoupon = data.coupons[1];
    historicalCoupon.issuedAt = new Date(Date.parse(historicalCoupon.expiresAt) - 60 * 24 * 60 * 60 * 1000).toISOString();
    data.members[0].createdAt = new Date(Date.parse(historicalCoupon.issuedAt) - 24 * 60 * 60 * 1000).toISOString();
    storage.raw = JSON.stringify(data);
    const repo = repository(storage);
    expect(await repo.load()).toEqual(data);
    expect(storage.writes).toBe(0);
    const granted = await repo.transact((draft) => grantStamp(draft, 'member_demo', NOW));
    expect(granted.coupons[1]).toEqual(historicalCoupon);
    expect(granted.coupons[2].expiresAt).toBe('2026-11-13T02:00:00.000Z');
    expect(await repository(storage).load()).toEqual(granted);
  });

  it('serializes rapid redemption requests and does not consume a coupon twice', async () => {
    const storage = new MemoryStorage();
    const repo = repository(storage);
    await repo.load();
    const issued = await repo.transact((data) => grantStamp(data, 'member_demo', NOW));
    const couponId = issued.coupons[2].id;
    const results = await Promise.allSettled([
      repo.transact((data) => redeemCoupon(data, couponId, NOW)),
      repo.transact((data) => redeemCoupon(data, couponId, NOW)),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(repo.getSnapshot()?.coupons[2].usedAt).toBe(NOW.toISOString());
    expect(storage.writes).toBe(3);
  });

  it('publishes only after the write succeeds and rolls back a rejected write', async () => {
    const storage = new MemoryStorage();
    const repo = repository(storage);
    const previous = await repo.load();
    const listener = vi.fn();
    const unsubscribe = repo.subscribe(listener);
    let release!: () => void;
    let reachedWrite!: () => void;
    const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
    storage.holdWrite = new Promise<void>((resolve) => { release = resolve; });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (data) => { reachedWrite(); await originalWrite(data); };
    storage.failWrite = true;
    const change = repo.transact((data) => registerMember(data, '保存できない会員', NOW));
    await writing;
    expect(repo.getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
    release();
    await expect(change).rejects.toThrow('保存に失敗');
    expect(repo.getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
    expect(JSON.parse(storage.raw!)).toEqual(previous);
    storage.holdWrite = null;
    storage.failWrite = false;
    const saved = await repo.transact((data) => registerMember(data, '保存できる会員', NOW));
    expect(repo.getSnapshot()).toBe(saved);
    expect(saved.members).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await repo.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps initial state unloaded if seeding cannot be saved and can retry', async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repo = repository(storage);
    await expect(repo.load()).rejects.toThrow('保存に失敗');
    expect(repo.getSnapshot()).toBeNull();
    expect(storage.raw).toBeNull();
    storage.failWrite = false;
    expect(await repo.load()).toEqual(createDemoData(NOW));
  });

  it('uses an isolated transaction draft and protects published snapshots against accidental mutation', async () => {
    const repo = repository(new MemoryStorage());
    const previous = await repo.load();
    await expect(repo.transact((draft) => {
      draft.members[0].nickname = '途中の編集';
      throw new Error('cancel');
    })).rejects.toThrow('cancel');
    expect(repo.getSnapshot()).toBe(previous);
    expect(previous.members[0].nickname).toBe('体験用の会員');
    expect(Object.isFrozen(previous)).toBe(true);
    expect(Object.isFrozen(previous.members[0])).toBe(true);
  });

  it('resets saved state, supports explicit recovery from corruption, and does not reset after a failed write', async () => {
    const storage = new MemoryStorage();
    const repo = repository(storage);
    await repo.load();
    const changed = await repo.transact((data) => registerMember(data, '消去対象', NOW));
    storage.failWrite = true;
    await expect(repo.reset()).rejects.toThrow('保存に失敗');
    expect(repo.getSnapshot()).toBe(changed);
    storage.failWrite = false;
    expect(await repo.reset()).toEqual(createDemoData(NOW));
    expect(await repository(storage).load()).toEqual(createDemoData(NOW));
    storage.raw = '{broken';
    const recovering = repository(storage);
    await expect(recovering.load()).rejects.toThrow('上書きしていません');
    expect(await recovering.reset()).toEqual(createDemoData(NOW));
    expect(await repository(storage).load()).toEqual(createDemoData(NOW));
  });

  it.each([
    ['unknown schema version', (data: DemoData) => { (data as { version: number }).version = 2; }],
    ['invalid stamp balance', (data: DemoData) => { data.members[0].stamps = 10; }],
    ['stamp balance inconsistent with event history', (data: DemoData) => { data.members[0].stamps = 8; }],
    ['unsafe membership number', (data: DemoData) => { data.members[0].number = '99999999999999999999'; }],
    ['dangling selected member', (data: DemoData) => { data.currentMemberId = 'missing'; }],
    ['duplicate same-day stamp', (data: DemoData) => { data.stamps.push({ ...data.stamps[0], id: 'duplicate' }); }],
    ['stamp date mismatch', (data: DemoData) => { data.stamps[0].japanDate = '2026-01-01'; }],
    ['unknown coupon owner', (data: DemoData) => { data.coupons[0].memberId = 'missing'; }],
    ['invalid coupon usage', (data: DemoData) => { data.coupons[0].usedAt = data.coupons[0].expiresAt; }],
    ['nonpositive coupon validity', (data: DemoData) => { data.coupons[0].expiresAt = data.coupons[0].issuedAt; }],
  ])('reports %s without overwriting persisted data', async (_name, corrupt) => {
    const storage = new MemoryStorage();
    const data = createDemoData(NOW);
    corrupt(data);
    storage.raw = JSON.stringify(data);
    const original = storage.raw;
    const repo = repository(storage);
    await expect(repo.load()).rejects.toThrow('保存データが破損');
    expect(repo.getSnapshot()).toBeNull();
    expect(storage.raw).toBe(original);
    expect(storage.writes).toBe(0);
    await expect(repo.transact((draft) => registerMember(draft, '会員', NOW))).rejects.toThrow('保存データが破損');
    expect(storage.raw).toBe(original);
    expect(storage.writes).toBe(0);
  });
});
