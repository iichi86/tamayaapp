import { describe, expect, it } from 'vitest';
import { couponStatus, createDemoData, grantStamp, japanDate, memberQr, parseMemberQr, redeemCoupon, registerMember, saveNotice, selectMember, stats } from '../src/domain/logic';

const NOW = new Date('2026-10-14T02:00:00.000Z');

describe('Japan calendar and stamp rules', () => {
  it('changes the shop date at midnight in Japan regardless of UTC date', () => {
    expect(japanDate(new Date('2026-10-14T14:59:59.999Z'))).toBe('2026-10-14');
    expect(japanDate(new Date('2026-10-14T15:00:00.000Z'))).toBe('2026-10-15');
  });

  it('seeds nine distinct previous Japan days and clearly identifies the sample member', () => {
    const data = createDemoData(new Date('2026-10-14T15:00:00.000Z'));
    expect(data.members[0]).toMatchObject({ stamps: 9, sample: true });
    expect(data.stamps.map((event) => event.japanDate)).toEqual([
      '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
      '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14',
    ]);
    expect(data.stamps.every((event) => event.source === 'sample')).toBe(true);
    expect(data.coupons.map((coupon) => couponStatus(coupon, NOW))).toEqual(['used', 'expired']);
  });

  it('consumes ten stamps for one coupon and rejects another grant on the same Japan day', () => {
    const original = createDemoData(NOW);
    const next = grantStamp(original, original.members[0].id, NOW);
    expect(next.members[0].stamps).toBe(0);
    expect(next.stamps).toHaveLength(10);
    expect(next.coupons).toHaveLength(3);
    expect(next.coupons[2]).toMatchObject({ issuedAt: NOW.toISOString(), usedAt: null, expiresAt: '2026-11-13T02:00:00.000Z' });
    expect(original.members[0].stamps).toBe(9);
    expect(original.stamps).toHaveLength(9);
    expect(() => grantStamp(next, original.members[0].id, new Date('2026-10-14T14:59:59.999Z'))).toThrow('本日のスタンプは付与済み');
    const tomorrow = grantStamp(next, original.members[0].id, new Date('2026-10-14T15:00:00.000Z'));
    expect(tomorrow.members[0].stamps).toBe(1);
    expect(tomorrow.coupons).toHaveLength(3);
  });
});

describe('coupon use and expiration', () => {
  it('is available just before the deadline and expired at the exact deadline', () => {
    const data = grantStamp(createDemoData(NOW), 'member_demo', NOW);
    const coupon = data.coupons[2];
    const deadline = new Date(coupon.expiresAt);
    const before = new Date(deadline.getTime() - 1);
    expect(couponStatus(coupon, before)).toBe('available');
    expect(couponStatus(coupon, deadline)).toBe('expired');
    expect(() => redeemCoupon(data, coupon.id, deadline)).toThrow('有効期限');
    const redeemed = redeemCoupon(data, coupon.id, before);
    expect(couponStatus(redeemed.coupons[2], deadline)).toBe('used');
    expect(() => redeemCoupon(redeemed, coupon.id, before)).toThrow('使用済み');
    expect(data.coupons[2].usedAt).toBeNull();
  });

  it('rejects use before issuance and use of an unknown coupon', () => {
    const data = grantStamp(createDemoData(NOW), 'member_demo', NOW);
    expect(() => redeemCoupon(data, data.coupons[2].id, new Date(NOW.getTime() - 1))).toThrow('発行日時');
    expect(() => redeemCoupon(data, 'missing', NOW)).toThrow('クーポンが見つかりません');
  });
});

describe('membership, notices, and daily totals', () => {
  it('registers a distinct member with no stamps and selects them', () => {
    const original = createDemoData(NOW);
    const data = registerMember(original, '  玉屋 花子  ', NOW);
    const member = data.members[1];
    expect(member).toMatchObject({ nickname: '玉屋 花子', stamps: 0, sample: false, number: '000002' });
    expect(data.currentMemberId).toBe(member.id);
    expect(data.stamps.filter((event) => event.memberId === member.id)).toHaveLength(0);
    expect(selectMember(data, 'member_demo').currentMemberId).toBe('member_demo');
    expect(() => selectMember(data, 'missing')).toThrow('会員が見つかりません');
    expect(() => registerMember(data, '   ', NOW)).toThrow('ニックネーム');
    expect(() => registerMember(data, 'あ'.repeat(21), NOW)).toThrow('ニックネーム');
  });

  it('round trips demo QR payloads and rejects unrelated or malformed QR content', () => {
    const member = createDemoData(NOW).members[0];
    expect(memberQr(member)).toBe('tamaya-demo:v1:member_demo');
    expect(parseMemberQr(`  ${memberQr(member)}\n`)).toBe(member.id);
    for (const invalid of ['https://example.com', 'tamaya-demo:v2:member_demo', 'tamaya-demo:v1:', 'tamaya-demo:v1:member/demo', 'tamaya-demo:v1:member_demo:extra']) {
      expect(parseMemberQr(invalid)).toBeNull();
    }
  });

  it('creates and edits an announcement without losing the rest, and rejects blank text', () => {
    const original = createDemoData(NOW);
    const later = new Date(NOW.getTime() + 1000);
    const added = saveNotice(original, { title: '  体験のお知らせ  ', body: '  保存した本文  ' }, later);
    expect(added.notices).toHaveLength(3);
    expect(added.notices[0]).toMatchObject({ title: '体験のお知らせ', body: '保存した本文', updatedAt: later.toISOString() });
    const edited = saveNotice(added, { id: added.notices[0].id, title: '編集した題名', body: '編集した本文' }, later);
    expect(edited.notices).toHaveLength(3);
    expect(edited.notices[0].id).toBe(added.notices[0].id);
    expect(original.notices).toHaveLength(2);
    expect(() => saveNotice(edited, { title: '', body: '本文' }, later)).toThrow('タイトル');
    expect(() => saveNotice(edited, { title: '題名', body: ' ' }, later)).toThrow('本文');
    expect(() => saveNotice(edited, { id: 'missing', title: '題名', body: '本文' }, later)).toThrow('見つかりません');
  });

  it('counts stamps and redemptions for the current Japan day', () => {
    const beforeMidnight = new Date('2026-10-14T14:59:59.999Z');
    const midnight = new Date('2026-10-14T15:00:00.000Z');
    const granted = grantStamp(createDemoData(beforeMidnight), 'member_demo', beforeMidnight);
    const redeemed = redeemCoupon(granted, granted.coupons[2].id, midnight);
    expect(stats(redeemed, beforeMidnight)).toEqual({ members: 1, stampsToday: 1, redemptionsToday: 0 });
    expect(stats(redeemed, midnight)).toEqual({ members: 1, stampsToday: 0, redemptionsToday: 1 });
  });
});
