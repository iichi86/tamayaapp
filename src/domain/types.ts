export type Member = { id: string; number: string; nickname: string; createdAt: string; stamps: number; sample: boolean };
export type StampEvent = { id: string; memberId: string; createdAt: string; japanDate: string; source: 'visit' | 'sample' };
export type Coupon = { id: string; memberId: string; issuedAt: string; expiresAt: string; usedAt: string | null };
export type Notice = { id: string; title: string; body: string; updatedAt: string };
export type DemoData = { version: 1; members: Member[]; stamps: StampEvent[]; coupons: Coupon[]; notices: Notice[]; currentMemberId: string | null };
export type CouponStatus = 'available' | 'used' | 'expired';
export interface StorageAdapter { read(): Promise<DemoData | null>; write(data: DemoData): Promise<void> }
