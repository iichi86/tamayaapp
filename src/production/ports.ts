import type {
  AccountDeletion, AccountSnapshot, AuditRecord, CouponResult, MemberPresentation,
  MemberSummary, ServerMember, ServerNotice, StaffAccount, StaffRole, StampResult,
  StoreInfo, StoreStats,
} from '../../shared/contracts';

export interface AuthUser { uid: string; email: string | null; emailVerified: boolean }
export interface AuthSnapshot { loading: boolean; user: AuthUser | null }
export interface AuthPort {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AuthSnapshot;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  sendVerification(): Promise<void>;
  resetPassword(email: string): Promise<void>;
  reloadUser(): Promise<void>;
  signOut(): Promise<void>;
  reauthenticate(password: string): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}
export interface ProductionApi {
  store(): Promise<StoreInfo>;
  notices(): Promise<ServerNotice[]>;
  me(): Promise<AccountSnapshot>;
  register(input: { nickname: string; acceptedTermsVersion: string; acceptedPrivacyVersion: string }): Promise<ServerMember>;
  updateNickname(nickname: string): Promise<ServerMember>;
  qr(): Promise<MemberPresentation>;
  deleteAccount(): Promise<AccountDeletion>;
  staffMembers(query: string): Promise<MemberSummary[]>;
  staffMember(id: string): Promise<ServerMember>;
  resolveQr(qr: string): Promise<ServerMember>;
  grantStamp(id: string, purchaseAmountYen: number): Promise<StampResult>;
  redeemCoupon(id: string, purchaseAmountYen?: number): Promise<CouponResult>;
  saveNotice(input: { id?: string; title: string; body: string }): Promise<ServerNotice>;
  stats(): Promise<StoreStats>;
  staffAccounts(): Promise<StaffAccount[]>;
  setStaffAccount(uid: string, input: { role: StaffRole; active: boolean }): Promise<StaffAccount>;
  audit(): Promise<AuditRecord[]>;
}
