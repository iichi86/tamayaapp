/** Public JSON contracts. No server credentials or Firebase Admin code belong here. */
export type StaffRole = 'owner' | 'staff';
export interface StaffAccount { uid: string; role: StaffRole; active: boolean }
export type RewardBenefit =
  | { kind: 'yen'; value: number; label: string }
  | { kind: 'percent'; value: number; label: string }
  | { kind: 'item'; label: string };
export interface RewardPolicy {
  version: string; stampsRequired: number; validityDays: number;
  dailyLimit: 1; timeZone: 'Asia/Tokyo'; benefit: RewardBenefit | null;
  minimumPurchaseYen: number; redemptionMinimumPurchaseYen: number;
  eligibleProducts: string[]; combinationRule: string | null;
  stampEligibleProducts?: string[];
  operationsEnabled: boolean;
}
export interface StoreInfo {
  id: string; name: string; area: string; address: string | null;
  phone: string | null; hours: string | null; informationSource: string | null;
  products: { id: string; name: string }[];
  operator: { name: string; phone: string; email: string | null };
  reward: RewardPolicy;
  legal: { termsVersion: string; privacyVersion: string; termsText: string; privacyText: string;
    supportText: string; privacyUrl: string | null; supportUrl: string | null };
}
export interface ServerNotice { id: string; title: string; body: string; updatedAt: string }
export interface ServerStamp { id: string; createdAt: string; japanDate: string; purchaseAmountYen: number }
export interface ServerCoupon {
  id: string; issuedAt: string; expiresAt: string; usedAt: string | null;
  status: 'available' | 'used' | 'expired';
  benefit: RewardBenefit; eligibleProducts: string[]; combinationRule: string;
  policyVersion: string;
  redemptionMinimumPurchaseYen: number;
}
export interface ServerMember {
  id: string; number: string; nickname: string; stamps: number; createdAt: string;
  stampHistory: ServerStamp[]; coupons: ServerCoupon[];
}
export interface MemberSummary { id: string; number: string; nickname: string; stamps: number }
export interface AccountSnapshot { member: ServerMember | null; staff: StaffAccount | null }
export interface StoreStats { members: number; stampsToday: number; redemptionsToday: number }
export interface AuditRecord { id: string; actorUid: string; action: string; targetId: string; createdAt: string; purchaseAmountYen?: number | null }
export interface MemberPresentation { qr: string; expiresAt: string }
export interface StampResult { member: ServerMember; coupon: ServerCoupon | null }
export interface CouponResult { member: ServerMember; coupon: ServerCoupon }
export interface AccountDeletion { status: 'pending' | 'completed' }
export interface ApiErrorBody { error: { code: string; message: string } }

/** All routes are under /v1/stores/:storeId. Bearer token except public store/notices. */
export const routes = {
  store: '', notices: '/notices', me: '/me', register: '/me/register', qr: '/me/qr',
  staffMembers: '/staff/members', resolveQr: '/staff/resolve-qr', stats: '/staff/stats',
  staffNotices: '/staff/notices', accounts: '/owner/staff', audit: '/owner/audit',
} as const;
