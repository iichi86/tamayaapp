import type {
  AccountDeletion, AccountSnapshot, AuditRecord, CouponResult, MemberSummary,
  ServerMember, ServerNotice, StaffAccount, StaffRole, StampResult, StoreInfo, StoreStats,
} from '../../../shared/contracts.js';

export interface ProductionIdentity {
  uid: string;
  projectId: string;
  emailVerified: boolean;
  authTime: number;
}
export interface ProductionVerifier {
  verify(token: string, options?: { allowUnverified?: boolean }): Promise<ProductionIdentity>;
  deleteUser(uid: string): Promise<void>;
  verifyStaffUid(uid: string): Promise<void>;
}
export interface ProductionMutation {
  actor: ProductionIdentity;
  idempotencyKey: string;
  fingerprint: string;
}
export interface RegistrationInput {
  nickname: string; acceptedTermsVersion: string; acceptedPrivacyVersion: string;
}
export interface DeletionJob { id: string; uid: string; projectId: string }
export interface ProductionDatabasePort {
  getStore(storeId: string): Promise<StoreInfo>;
  getMe(storeId: string, identity: ProductionIdentity): Promise<AccountSnapshot>;
  getStaff(storeId: string, identity: ProductionIdentity): Promise<StaffAccount | null>;
  register(storeId: string, identity: ProductionIdentity, input: RegistrationInput): Promise<ServerMember>;
  updateNickname(storeId: string, identity: ProductionIdentity, nickname: string): Promise<ServerMember>;
  getMember(storeId: string, memberId: string, actor: ProductionIdentity): Promise<ServerMember>;
  listMembers(storeId: string, query: string, actor: ProductionIdentity): Promise<MemberSummary[]>;
  grantStamp(storeId: string, memberId: string, purchaseAmountYen: number, mutation: ProductionMutation): Promise<StampResult>;
  redeemCoupon(storeId: string, couponId: string, purchaseAmountYen: number, mutation: ProductionMutation): Promise<CouponResult>;
  listNotices(storeId: string): Promise<ServerNotice[]>;
  saveNotice(storeId: string, input: { id?: string; title: string; body: string }, mutation: ProductionMutation): Promise<ServerNotice>;
  stats(storeId: string, actor: ProductionIdentity): Promise<StoreStats>;
  listStaff(storeId: string, actor: ProductionIdentity): Promise<StaffAccount[]>;
  setStaff(storeId: string, targetUid: string, role: StaffRole, active: boolean, mutation: ProductionMutation): Promise<StaffAccount>;
  audit(storeId: string, actor: ProductionIdentity): Promise<AuditRecord[]>;
  requestDeletion(storeId: string, identity: ProductionIdentity): Promise<AccountDeletion>;
  pendingDeletions(projectId?: string): Promise<DeletionJob[]>;
  deletionStatus(projectId: string, uid: string): Promise<'pending' | 'completed'>;
  completeDeletion(jobId: string): Promise<void>;
  close(): Promise<void>;
}
