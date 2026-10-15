import { shop } from '../config/shop';
import { japanDate } from '../domain/logic';
import type { DemoData, StampEvent } from '../domain/types';

export class CorruptDemoDataError extends Error {
  constructor() {
    super('保存データが破損しているか、対応していない形式です。データは上書きしていません。');
    this.name = 'CorruptDemoDataError';
  }
}

function fail(): never {
  throw new CorruptDemoDataError();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail();
  return value;
}

function id(value: unknown): string {
  const result = string(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail();
  return result;
}

function date(value: unknown): string {
  const result = string(value, 40);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) fail();
  return result;
}

function list<T>(value: unknown, parse: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) fail();
  return value.map((item) => parse(object(item)));
}

function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail();
}

/** Validate and copy untrusted storage data before it can become app state. */
export function validateDemoData(value: unknown): DemoData {
  const data = object(value);
  if (data.version !== 1) fail();
  const members = list(data.members, (member) => {
    if (typeof member.stamps !== 'number' || !Number.isInteger(member.stamps) || member.stamps < 0 || member.stamps >= shop.reward.stampsRequired || typeof member.sample !== 'boolean') fail();
    const number = string(member.number, 20);
    if (!/^\d{6,}$/.test(number) || !Number.isSafeInteger(Number(number)) || Number(number) < 1) fail();
    return { id: id(member.id), number, nickname: string(member.nickname, 20), createdAt: date(member.createdAt), stamps: member.stamps, sample: member.sample };
  });
  const memberIds = new Set(members.map((member) => member.id));
  const stamps = list<StampEvent>(data.stamps, (stamp) => {
    const createdAt = date(stamp.createdAt);
    const day = string(stamp.japanDate, 10);
    if (day !== japanDate(new Date(createdAt)) || (stamp.source !== 'sample' && stamp.source !== 'visit')) fail();
    const memberId = id(stamp.memberId);
    if (!memberIds.has(memberId)) fail();
    return { id: id(stamp.id), memberId, createdAt, japanDate: day, source: stamp.source };
  });
  const coupons = list(data.coupons, (coupon) => {
    const memberId = id(coupon.memberId);
    const issuedAt = date(coupon.issuedAt);
    const expiresAt = date(coupon.expiresAt);
    const usedAt = coupon.usedAt === null ? null : date(coupon.usedAt);
    if (!memberIds.has(memberId) || Date.parse(expiresAt) <= Date.parse(issuedAt)) fail();
    if (usedAt !== null && (Date.parse(usedAt) < Date.parse(issuedAt) || Date.parse(usedAt) >= Date.parse(expiresAt))) fail();
    return { id: id(coupon.id), memberId, issuedAt, expiresAt, usedAt };
  });
  const notices = list(data.notices, (notice) => ({ id: id(notice.id), title: string(notice.title, 80), body: string(notice.body), updatedAt: date(notice.updatedAt) }));
  const currentMemberId = data.currentMemberId === null ? null : id(data.currentMemberId);
  if (currentMemberId !== null && !memberIds.has(currentMemberId)) fail();
  unique(members.map((member) => member.id));
  unique(members.map((member) => member.number));
  unique(stamps.map((stamp) => stamp.id));
  unique(stamps.map((stamp) => `${stamp.memberId}:${stamp.japanDate}`));
  const stampCounts = new Map<string, number>();
  for (const stamp of stamps) stampCounts.set(stamp.memberId, (stampCounts.get(stamp.memberId) ?? 0) + 1);
  for (const member of members) {
    if ((stampCounts.get(member.id) ?? 0) % shop.reward.stampsRequired !== member.stamps) fail();
  }
  unique(coupons.map((coupon) => coupon.id));
  unique(notices.map((notice) => notice.id));
  return { version: 1, members, stamps, coupons, notices, currentMemberId };
}
