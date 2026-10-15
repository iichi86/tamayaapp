import { shop } from '../config/shop';
import type { Coupon, CouponStatus, DemoData, Member, Notice } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;
const QR_PREFIX = 'tamaya-demo:v1:';
let sequence = 0;

function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('日時を確認してください。');
  return now.toISOString();
}

function newId(prefix: string, now: Date): string {
  sequence += 1;
  return `${prefix}_${now.getTime().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireMember(data: DemoData, id: string): Member {
  const member = data.members.find((item) => item.id === id);
  if (!member) throw new Error('会員が見つかりません。');
  return member;
}

/** The calendar date at the shop, independent of the device's time zone. */
export function japanDate(now: Date = new Date()): string {
  timestamp(now);
  return new Date(now.getTime() + JAPAN_OFFSET_MS).toISOString().slice(0, 10);
}

export function couponStatus(coupon: Coupon, now: Date = new Date()): CouponStatus {
  timestamp(now);
  if (coupon.usedAt !== null) return 'used';
  return now.getTime() >= Date.parse(coupon.expiresAt) ? 'expired' : 'available';
}

export function memberQr(member: Member): string {
  return `${QR_PREFIX}${member.id}`;
}

/** Demo identifiers only; this payload is never a production authorization token. */
export function parseMemberQr(input: string): string | null {
  const value = input.trim();
  if (!value.startsWith(QR_PREFIX)) return null;
  const id = value.slice(QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function createDemoData(now: Date = new Date()): DemoData {
  const today = japanDate(now);
  const todayMidnight = Date.parse(`${today}T00:00:00+09:00`);
  const memberId = 'member_demo';
  const historicalDate = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  return {
    version: 1,
    currentMemberId: null,
    members: [{
      id: memberId,
      number: '000001',
      nickname: '体験用の会員',
      createdAt: historicalDate(Math.max(60, shop.reward.validityDays + 15)),
      stamps: shop.reward.stampsRequired - 1,
      sample: true,
    }],
    stamps: Array.from({ length: shop.reward.stampsRequired - 1 }, (_, index) => {
      const date = new Date(todayMidnight - (shop.reward.stampsRequired - 1 - index) * DAY_MS + 12 * 60 * 60 * 1000);
      return { id: `stamp_demo_${index + 1}`, memberId, createdAt: date.toISOString(), japanDate: japanDate(date), source: 'sample' as const };
    }),
    coupons: [
      { id: 'coupon_demo_used', memberId, issuedAt: historicalDate(10 + shop.reward.validityDays), expiresAt: historicalDate(10), usedAt: historicalDate(10 + shop.reward.validityDays / 2) },
      { id: 'coupon_demo_expired', memberId, issuedAt: historicalDate(15 + shop.reward.validityDays), expiresAt: historicalDate(15), usedAt: null },
    ],
    notices: [
      { id: 'notice_demo', title: '体験版をご利用の方へ', body: '会員情報・スタンプ・クーポンは体験用です。この端末のみに保存され、実店舗ではご利用いただけません。', updatedAt: timestamp(now) },
      { id: 'notice_stamps', title: 'スタンプカードの使い方', body: `この体験版では、1日1回スタンプをためられます。${shop.reward.stampsRequired}個で${shop.reward.discountYen}円引きの体験用クーポンを発行します。有効期間は発行から${shop.reward.validityDays}日です。`, updatedAt: timestamp(now) },
    ],
  };
}

export function registerMember(data: DemoData, nickname: string, now: Date = new Date()): DemoData {
  const name = nickname.trim();
  if (!name || name.length > 20) throw new Error('ニックネームは1〜20文字で入力してください。');
  const createdAt = timestamp(now);
  const largestNumber = data.members.reduce((maximum, member) => Math.max(maximum, Number(member.number)), 0);
  const member: Member = {
    id: newId('member', now), number: String(largestNumber + 1).padStart(6, '0'), nickname: name,
    createdAt, stamps: 0, sample: false,
  };
  return { ...data, members: [...data.members, member], currentMemberId: member.id };
}

export function selectMember(data: DemoData, id: string): DemoData {
  requireMember(data, id);
  return { ...data, currentMemberId: id };
}

export function grantStamp(data: DemoData, id: string, now: Date = new Date()): DemoData {
  const member = requireMember(data, id);
  const today = japanDate(now);
  if (data.stamps.some((event) => event.memberId === id && event.japanDate === today)) {
    throw new Error('本日のスタンプは付与済みです。1日1回までご利用いただけます。');
  }
  const createdAt = timestamp(now);
  const balance = member.stamps + 1;
  const earnsCoupon = balance >= shop.reward.stampsRequired;
  const coupons = earnsCoupon ? [...data.coupons, {
    id: newId('coupon', now), memberId: id, issuedAt: createdAt,
    expiresAt: new Date(now.getTime() + shop.reward.validityDays * DAY_MS).toISOString(), usedAt: null,
  }] : data.coupons;
  return {
    ...data,
    members: data.members.map((item) => item.id === id ? { ...item, stamps: earnsCoupon ? balance - shop.reward.stampsRequired : balance } : item),
    stamps: [...data.stamps, { id: newId('stamp', now), memberId: id, createdAt, japanDate: today, source: 'visit' }],
    coupons,
  };
}

export function redeemCoupon(data: DemoData, couponId: string, now: Date = new Date()): DemoData {
  const coupon = data.coupons.find((item) => item.id === couponId);
  if (!coupon) throw new Error('クーポンが見つかりません。');
  const status = couponStatus(coupon, now);
  if (status === 'used') throw new Error('このクーポンは使用済みです。');
  if (status === 'expired') throw new Error('このクーポンの有効期限が切れています。');
  if (now.getTime() < Date.parse(coupon.issuedAt)) throw new Error('発行日時より前にはクーポンを使用できません。');
  return { ...data, coupons: data.coupons.map((item) => item.id === couponId ? { ...item, usedAt: timestamp(now) } : item) };
}

export function saveNotice(data: DemoData, input: { id?: string; title: string; body: string }, now: Date = new Date()): DemoData {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || title.length > 80) throw new Error('お知らせのタイトルは1〜80文字で入力してください。');
  if (!body || body.length > 1000) throw new Error('お知らせの本文は1〜1000文字で入力してください。');
  if (input.id && !data.notices.some((notice) => notice.id === input.id)) throw new Error('お知らせが見つかりません。');
  const notice: Notice = { id: input.id ?? newId('notice', now), title, body, updatedAt: timestamp(now) };
  const notices = input.id ? data.notices.map((item) => item.id === input.id ? notice : item) : [...data.notices, notice];
  return { ...data, notices: [...notices].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

export function stats(data: DemoData, now: Date = new Date()): { members: number; stampsToday: number; redemptionsToday: number } {
  const today = japanDate(now);
  return {
    members: data.members.length,
    stampsToday: data.stamps.filter((event) => event.japanDate === today).length,
    redemptionsToday: data.coupons.filter((coupon) => coupon.usedAt !== null && japanDate(new Date(coupon.usedAt)) === today).length,
  };
}
