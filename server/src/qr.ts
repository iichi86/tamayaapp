import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from './types.js';

const PREFIX = 'tamaya-member:v1.';
export const QR_TTL_MS = 2 * 60 * 1000;

interface Presentation {
  purpose: 'member-presentation';
  storeId: string;
  memberId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function invalidQr(): DomainError {
  return new DomainError('INVALID_QR', 400, '会員QRが無効か期限切れです。お客様の会員証を開き直してください。');
}

function signature(encoded: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}${encoded}`).digest();
}

export function createMemberQr(
  member: { storeId: string; memberId: string },
  secret: string,
  now: Date = new Date(),
): { qr: string; expiresAt: string } {
  const issuedAt = now.getTime();
  if (!Number.isFinite(issuedAt)) throw new Error('Invalid server clock');
  const payload: Presentation = {
    purpose: 'member-presentation', ...member,
    issuedAt, expiresAt: issuedAt + QR_TTL_MS, nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    qr: `${PREFIX}${encoded}.${signature(encoded, secret).toString('base64url')}`,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export function readMemberQr(qr: string, expectedStoreId: string, secret: string, now: Date = new Date()): { storeId: string; memberId: string } {
  try {
    if (qr.length > 2048 || !qr.startsWith(PREFIX)) throw invalidQr();
    const parts = qr.slice(PREFIX.length).split('.');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw invalidQr();
    const [encoded, supplied] = parts;
    const actual = Buffer.from(supplied, 'base64url');
    const expected = signature(encoded, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidQr();
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidQr();
    const value = payload as Partial<Presentation>;
    const time = now.getTime();
    if (value.purpose !== 'member-presentation' || value.storeId !== expectedStoreId
      || typeof value.memberId !== 'string' || !value.memberId || value.memberId.length > 128
      || typeof value.nonce !== 'string' || value.nonce.length !== 36
      || !Number.isFinite(time) || typeof value.issuedAt !== 'number' || typeof value.expiresAt !== 'number'
      || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt - value.issuedAt !== QR_TTL_MS || value.issuedAt > time || value.expiresAt <= time) {
      throw invalidQr();
    }
    return { storeId: expectedStoreId, memberId: value.memberId };
  } catch {
    throw invalidQr();
  }
}
