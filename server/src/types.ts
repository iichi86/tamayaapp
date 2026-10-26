export interface Identity { uid: string; projectId: string }
export interface TokenVerifier { verify(token: string, expectedProjectId: string): Promise<Identity> }
export type StaffRole = 'owner' | 'staff';
export interface Store {
  id: string; name: string; firebaseProjectId: string;
  stampsRequired: number; discountYen: number; validityDays: number;
}
export interface Staff { uid: string; storeId: string; role: StaffRole; active: boolean }
export interface StampRecord { id: string; memberId: string; createdAt: string; japanDate: string }
export interface CouponRecord {
  id: string; storeId: string; memberId: string; issuedAt: string; expiresAt: string;
  usedAt: string | null; discountYen: number; stampsRequired: number;
  status: 'available' | 'used' | 'expired';
}
export interface MemberView {
  id: string; storeId: string; number: string; nickname: string; stamps: number;
  createdAt: string; stampHistory: StampRecord[]; coupons: CouponRecord[];
}
export interface MemberSummary { id: string; number: string; nickname: string; stamps: number }
export interface Notice { id: string; storeId: string; title: string; body: string; updatedAt: string }
export interface Stats { members: number; stampsToday: number; redemptionsToday: number }
export interface AuditEntry {
  id: string; storeId: string; actorUid: string; action: string; targetId: string; createdAt: string;
}
export interface Mutation {
  actor: Identity; idempotencyKey: string; fingerprint: string;
}
export interface GrantResult { member: MemberView; stamp: StampRecord; coupon: CouponRecord | null }
export interface RedeemResult { member: MemberView; coupon: CouponRecord }
export class DomainError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message); this.name = 'DomainError';
  }
}

export interface DatabasePort {
  createStore(store: Store): Store;
  getStore(storeId: string): Store;
  bootstrapOwner(storeId: string, uid: string): void;
  registerMember(storeId: string, identity: Identity, nickname: string): MemberView;
  getOwnMember(storeId: string, identity: Identity): MemberView;
  getMember(storeId: string, memberId: string): MemberView;
  listMembers(storeId: string, query?: string): MemberSummary[];
  getStaff(storeId: string, identity: Identity): Staff | null;
  setStaff(storeId: string, targetUid: string, role: StaffRole, active: boolean, mutation: Mutation): Staff;
  listStaff(storeId: string, actor: Identity): Staff[];
  grantStamp(storeId: string, memberId: string, mutation: Mutation): GrantResult;
  redeemCoupon(storeId: string, couponId: string, mutation: Mutation): RedeemResult;
  listNotices(storeId: string): Notice[];
  saveNotice(storeId: string, input: { id?: string; title: string; body: string }, mutation: Mutation): Notice;
  stats(storeId: string): Stats;
  audit(storeId: string, actor: Identity): AuditEntry[];
  seedDemo(): { storeId: string; memberId: string };
  close(): void;
}
