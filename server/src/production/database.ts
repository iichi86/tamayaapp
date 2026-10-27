import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  AccountDeletion, AccountSnapshot, AuditRecord, CouponResult, MemberSummary,
  RewardPolicy, ServerCoupon, ServerMember, ServerNotice, StaffAccount, StaffRole,
  StampResult, StoreInfo, StoreStats,
} from '../../../shared/contracts.js';
import { DomainError } from '../types.js';
import type {
  DeletionJob, ProductionDatabasePort, ProductionIdentity, ProductionMutation, RegistrationInput,
} from './types.js';

type Connection = Pick<PoolClient, 'query'>;
type StoreRow = { id: string; firebase_project_id: string; info: StoreInfo };
type MemberRow = { id: string; store_id: string; uid: string; number: string; nickname: string;
  stamps: number; state: string; created_at: Date };
type CouponRow = { id: string; store_id: string; member_id: string | null; issued_at: Date;
  expires_at: Date; used_at: Date | null; benefit: ServerCoupon['benefit'];
  eligible_products: string[]; combination_rule: string; policy_version: string;
  redemption_minimum_purchase_yen: number; used_purchase_amount_yen: number | null };
const failure = (code: string, status: number, message: string) => new DomainError(code, status, message);
const iso = (value: Date | string) => new Date(value).toISOString();
const jstDate = (value: Date) => new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const validUid = (uid: string) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;

/** One pool per process; all business operations use PostgreSQL transactions. */
export class PostgresDatabase implements ProductionDatabasePort {
  readonly pool: Pool;
  constructor(config: Pool | string | PoolConfig, private readonly options: { now?: () => Date } = {}) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === 'string' ? { connectionString: config } : config);
  }

  async migrate(): Promise<void> {
    let sql: string;
    try { sql = await readFile(new URL('../../supabase/001_initial.sql', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Compiled code lives in dist/server/src/production; SQL stays server/supabase.
      sql = await readFile(resolve('supabase/001_initial.sql'), 'utf8');
    }
    await this.pool.query(sql);
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async now(client: Connection): Promise<Date> {
    const result = this.options.now?.() ?? (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    if (!Number.isFinite(result.getTime())) throw new Error('Invalid server clock');
    return result;
  }

  private async store(client: Connection, id: string, lock: 'share' | 'update' | false = false): Promise<StoreRow> {
    const { rows } = await client.query<StoreRow>(`SELECT * FROM tamaya.stores WHERE id=$1${lock ? ` FOR ${lock.toUpperCase()}` : ''}`, [id]);
    if (!rows[0]) throw failure('STORE_NOT_FOUND', 404, '店舗が見つかりません。');
    return rows[0];
  }

  private async identity(client: Connection, store: StoreRow, actor: ProductionIdentity): Promise<void> {
    if (!actor || !validUid(actor.uid) || actor.projectId !== store.firebase_project_id) {
      throw failure('UNAUTHENTICATED', 401, 'この店舗でのログインを確認できません。');
    }
    if (!actor.emailVerified) throw failure('EMAIL_NOT_VERIFIED', 403, '確認メールのリンクを開いてからログインしてください。');
    if ((await client.query('SELECT 1 FROM tamaya.deletion_jobs WHERE firebase_project_id=$1 AND uid=$2 AND state=\'pending\'', [actor.projectId, actor.uid])).rowCount) {
      throw failure('ACCOUNT_DELETING', 410, '退会処理中です。完了までお待ちください。');
    }
  }

  private async staff(client: Connection, store: StoreRow, actor: ProductionIdentity, owner = false): Promise<StaffAccount> {
    await this.identity(client, store, actor);
    const { rows } = await client.query<StaffAccount>('SELECT uid,role,active FROM tamaya.staff WHERE store_id=$1 AND uid=$2 FOR SHARE', [store.id, actor.uid]);
    if (!rows[0]?.active || (owner && rows[0].role !== 'owner')) {
      throw failure('FORBIDDEN', 403, owner ? 'オーナー権限が必要です。' : '店舗スタッフの権限が必要です。');
    }
    return rows[0];
  }

  private async member(client: Connection, storeId: string, memberId: string, lock = false): Promise<MemberRow> {
    if (!/^[0-9a-f-]{36}$/i.test(memberId)) throw failure('MEMBER_NOT_FOUND', 404, '会員が見つかりません。');
    const { rows } = await client.query<MemberRow>(`SELECT * FROM tamaya.members WHERE store_id=$1 AND id=$2 AND state='active'${lock ? ' FOR UPDATE' : ''}`, [storeId, memberId]);
    if (!rows[0]) throw failure('MEMBER_NOT_FOUND', 404, '会員が見つかりません。');
    return rows[0];
  }

  private couponView(row: CouponRow, now: Date): ServerCoupon {
    return {
      id: row.id, issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at), usedAt: row.used_at ? iso(row.used_at) : null,
      status: row.used_at ? 'used' : row.expires_at.getTime() <= now.getTime() ? 'expired' : 'available',
      benefit: row.benefit, eligibleProducts: row.eligible_products, combinationRule: row.combination_rule, policyVersion: row.policy_version,
      redemptionMinimumPurchaseYen: row.redemption_minimum_purchase_yen,
    };
  }

  private async memberView(client: Connection, member: MemberRow, now: Date): Promise<ServerMember> {
    const history = await client.query<{ id: string; created_at: Date; japan_date: string; purchase_amount_yen: number }>(
      'SELECT id,created_at,japan_date::text,purchase_amount_yen FROM tamaya.stamp_events WHERE store_id=$1 AND member_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100', [member.store_id, member.id]);
    const coupons = await client.query<CouponRow>('SELECT * FROM tamaya.coupons WHERE store_id=$1 AND member_id=$2 ORDER BY issued_at DESC,id DESC LIMIT 100', [member.store_id, member.id]);
    return {
      id: member.id, number: member.number, nickname: member.nickname, stamps: member.stamps, createdAt: iso(member.created_at),
      stampHistory: history.rows.map((row) => ({ id: row.id, createdAt: iso(row.created_at), japanDate: row.japan_date, purchaseAmountYen: row.purchase_amount_yen })),
      coupons: coupons.rows.map((row) => this.couponView(row, now)),
    };
  }

  private async log(client: Connection, storeId: string, actorUid: string, action: string, targetId: string, now: Date, memberId: string | null = null, purchaseAmountYen: number | null = null): Promise<void> {
    await client.query('INSERT INTO tamaya.audit_log(id,store_id,actor_uid,action,target_id,member_id,created_at,purchase_amount_yen) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), storeId, actorUid, action, targetId, memberId, now, purchaseAmountYen]);
  }

  private validatePolicy(policy: RewardPolicy): void {
    if (!policy.version?.trim() || !Number.isSafeInteger(policy.stampsRequired) || policy.stampsRequired < 1 || policy.stampsRequired > 1000
      || !Number.isSafeInteger(policy.validityDays) || policy.validityDays < 1 || policy.validityDays > 3660
      || policy.dailyLimit !== 1 || policy.timeZone !== 'Asia/Tokyo' || !Array.isArray(policy.eligibleProducts)) {
      throw failure('INVALID_POLICY', 400, '特典条件の設定を確認してください。');
    }
    if (![policy.minimumPurchaseYen, policy.redemptionMinimumPurchaseYen].every((amount) => Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000)) {
      throw failure('INVALID_POLICY', 400, 'スタンプ・特典利用の最低お会計額を確認してください。');
    }
    if (policy.operationsEnabled) {
      const b = policy.benefit;
      if (!b || !['yen', 'percent', 'item'].includes(b.kind) || !b.label?.trim() || !policy.combinationRule?.trim() || !policy.eligibleProducts.length
        || policy.eligibleProducts.some((name) => typeof name !== 'string' || !name.trim())
        || (b.kind !== 'item' && (!Number.isSafeInteger(b.value) || b.value < 1 || (b.kind === 'percent' && b.value > 100)))) {
        throw failure('RULES_NOT_READY', 409, '正式な特典内容・対象商品・併用条件の確定が必要です。');
      }
    }
  }

  private ready(policy: RewardPolicy): void {
    this.validatePolicy(policy);
    if (!policy.operationsEnabled || !policy.benefit || !policy.combinationRule) {
      throw failure('RULES_NOT_READY', 409, '正式な特典条件を確認中のため、スタンプ・特典の操作を停止しています。');
    }
  }

  private purchase(amount: number, minimum: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) {
      throw failure('INVALID_PURCHASE_AMOUNT', 400, 'お会計額を0〜100,000,000円の整数で入力してください。');
    }
    if (amount < minimum) throw failure('PURCHASE_TOO_SMALL', 409, `この操作には${minimum.toLocaleString('ja-JP')}円以上のお会計が必要です。`);
  }

  /** Administrative CLI only. Changes require a new policy version; no customer API calls this. */
  async upsertStore(info: StoreInfo, projectId: string): Promise<void> {
    if (!/^[a-z0-9-]{1,64}$/.test(info.id) || !projectId || !info.name?.trim() || !info.legal.termsVersion || !info.legal.privacyVersion) {
      throw failure('INVALID_STORE', 400, '店舗・認証・利用規約の設定を確認してください。');
    }
    this.validatePolicy(info.reward);
    await this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`store:${info.id}`]);
      const { rows } = await client.query<StoreRow>('SELECT * FROM tamaya.stores WHERE id=$1 FOR UPDATE', [info.id]);
      if (rows[0] && rows[0].firebase_project_id !== projectId) throw failure('PROJECT_MISMATCH', 409, '既存店舗のFirebaseプロジェクトは変更できません。');
      if (rows[0] && rows[0].info.reward.version === info.reward.version && JSON.stringify(rows[0].info.reward) !== JSON.stringify(info.reward)) {
        // JSONB key ordering differs from JS object ordering; compare canonical object values.
        const equal = await client.query<{ equal: boolean }>('SELECT $1::jsonb = $2::jsonb AS equal', [rows[0].info.reward, JSON.stringify(info.reward)]);
        if (!equal.rows[0].equal) throw failure('POLICY_VERSION_REQUIRED', 409, '特典条件の変更時は新しいバージョンを設定してください。');
      }
      await client.query('INSERT INTO tamaya.stores(id,firebase_project_id,info) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET info=EXCLUDED.info', [info.id, projectId, JSON.stringify(info)]);
    });
  }

  async bootstrapOwner(storeId: string, uid: string): Promise<void> {
    if (!validUid(uid)) throw failure('INVALID_UID', 400, 'オーナーのUIDを確認してください。');
    await this.tx(async (client) => {
      const store = await this.store(client, storeId, 'update');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`register:${store.firebase_project_id}:${uid}`]);
      if ((await client.query('SELECT 1 FROM tamaya.deletion_jobs WHERE firebase_project_id=$1 AND uid=$2 AND state=\'pending\'', [store.firebase_project_id, uid])).rowCount) {
        throw failure('ACCOUNT_DELETING', 409, '退会処理中のアカウントにはオーナー権限を設定できません。');
      }
      await client.query('INSERT INTO tamaya.staff(store_id,uid,role,active) VALUES($1,$2,\'owner\',true) ON CONFLICT(store_id,uid) DO UPDATE SET role=\'owner\',active=true', [storeId, uid]);
      await this.log(client, storeId, 'trusted-bootstrap', 'owner.bootstrap', uid, await this.now(client));
    });
  }

  async getStore(storeId: string): Promise<StoreInfo> { return (await this.store(this.pool, storeId)).info; }

  async getMe(storeId: string, actor: ProductionIdentity): Promise<AccountSnapshot> {
    return this.tx(async (client) => {
      const store = await this.store(client, storeId);
      await this.identity(client, store, actor);
      const member = (await client.query<MemberRow>('SELECT * FROM tamaya.members WHERE store_id=$1 AND uid=$2 AND state=\'active\'', [storeId, actor.uid])).rows[0];
      const staff = (await client.query<StaffAccount>('SELECT uid,role,active FROM tamaya.staff WHERE store_id=$1 AND uid=$2 AND active=true', [storeId, actor.uid])).rows[0] ?? null;
      return { member: member ? await this.memberView(client, member, await this.now(client)) : null, staff };
    });
  }

  async getStaff(storeId: string, actor: ProductionIdentity): Promise<StaffAccount | null> {
    return (await this.getMe(storeId, actor)).staff;
  }

  async register(storeId: string, actor: ProductionIdentity, input: RegistrationInput): Promise<ServerMember> {
    const nickname = this.nickname(input.nickname);
    return this.tx(async (client) => {
      const store = await this.store(client, storeId, 'share');
      await this.identity(client, store, actor);
      if (input.acceptedTermsVersion !== store.info.legal.termsVersion || input.acceptedPrivacyVersion !== store.info.legal.privacyVersion) {
        throw failure('CONSENT_REQUIRED', 409, '最新の利用規約とプライバシーポリシーを確認して同意してください。');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`register:${actor.projectId}:${actor.uid}`]);
      await this.identity(client, store, actor); // Deletion may have committed while this registration waited.
      const existing = (await client.query<MemberRow>('SELECT * FROM tamaya.members WHERE store_id=$1 AND uid=$2', [storeId, actor.uid])).rows[0];
      const now = await this.now(client);
      if (existing) {
        if (existing.state !== 'active') throw failure('ACCOUNT_DELETING', 410, '退会処理中です。');
        return this.memberView(client, existing, now);
      }
      let number: string;
      do { number = String(randomInt(1_000_000_000, 10_000_000_000)); }
      while ((await client.query('SELECT 1 FROM tamaya.members WHERE store_id=$1 AND number=$2', [storeId, number])).rowCount);
      const row = (await client.query<MemberRow>(
        'INSERT INTO tamaya.members(id,store_id,uid,number,nickname,terms_version,privacy_version,accepted_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',
        [randomUUID(), storeId, actor.uid, number, nickname, input.acceptedTermsVersion, input.acceptedPrivacyVersion, now])).rows[0];
      await this.log(client, storeId, actor.uid, 'member.register', row.id, now, row.id);
      return this.memberView(client, row, now);
    });
  }

  private nickname(value: string): string {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw failure('INVALID_NICKNAME', 400, 'ニックネームを1〜40文字で入力してください。');
    }
    return value.trim();
  }

  async updateNickname(storeId: string, actor: ProductionIdentity, nickname: string): Promise<ServerMember> {
    const next = this.nickname(nickname);
    return this.tx(async (client) => {
      const store = await this.store(client, storeId);
      await this.identity(client, store, actor);
      const member = (await client.query<MemberRow>('UPDATE tamaya.members SET nickname=$3 WHERE store_id=$1 AND uid=$2 AND state=\'active\' RETURNING *', [storeId, actor.uid, next])).rows[0];
      if (!member) throw failure('MEMBER_NOT_FOUND', 404, '先に会員登録をしてください。');
      const now = await this.now(client);
      await this.log(client, storeId, actor.uid, 'member.nickname', member.id, now, member.id);
      return this.memberView(client, member, now);
    });
  }

  async getMember(storeId: string, memberId: string, actor: ProductionIdentity): Promise<ServerMember> {
    return this.tx(async (client) => {
      await this.staff(client, await this.store(client, storeId), actor);
      return this.memberView(client, await this.member(client, storeId, memberId), await this.now(client));
    });
  }

  async listMembers(storeId: string, query: string, actor: ProductionIdentity): Promise<MemberSummary[]> {
    return this.tx(async (client) => {
      await this.staff(client, await this.store(client, storeId), actor);
      const text = typeof query === 'string' ? query.trim() : '';
      if (!text || text.length > 40) return [];
      // Escape wildcard characters. Empty queries never enumerate the membership list.
      const escaped = text.replace(/[\\%_]/g, '\\$&');
      return (await client.query<MemberSummary>('SELECT id,number,nickname,stamps FROM tamaya.members WHERE store_id=$1 AND state=\'active\' AND (number=$2 OR nickname ILIKE $3 ESCAPE \'\\\') ORDER BY created_at DESC LIMIT 20', [storeId, text, `%${escaped}%`])).rows;
    });
  }

  private async mutate<T>(storeId: string, mutation: ProductionMutation, action: (client: PoolClient, store: StoreRow, now: Date) => Promise<{ result: T; memberId?: string }>, owner = false): Promise<T> {
    if (!mutation || typeof mutation.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(mutation.idempotencyKey)
      || typeof mutation.fingerprint !== 'string' || !mutation.fingerprint || mutation.fingerprint.length > 256) {
      throw failure('IDEMPOTENCY_REQUIRED', 400, '操作IDを確認してください。');
    }
    return this.tx(async (client) => {
      const store = await this.store(client, storeId, owner ? 'update' : 'share');
      await this.staff(client, store, mutation.actor, owner);
      // Serialize equal receipts across independent pools/processes, before checking the cache.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`receipt:${storeId}:${mutation.actor.uid}:${mutation.idempotencyKey}`]);
      const previous = (await client.query<{ fingerprint: string; response: T; member_id: string | null }>('SELECT fingerprint,response,member_id FROM tamaya.idempotency WHERE store_id=$1 AND actor_uid=$2 AND key=$3', [storeId, mutation.actor.uid, mutation.idempotencyKey])).rows[0];
      if (previous) {
        if (previous.fingerprint !== mutation.fingerprint) throw failure('IDEMPOTENCY_CONFLICT', 409, '同じ操作IDを別の操作には使用できません。');
        // A successful historical receipt must not reveal a pending/deleted member.
        if (previous.member_id) {
          const member = await this.member(client, storeId, previous.member_id);
          const receipt = previous.response as { format?: string; couponId?: string | null };
          if (receipt.format === 'member-effect-v1') {
            const now = await this.now(client);
            const coupon = receipt.couponId ? (await client.query<CouponRow>('SELECT * FROM tamaya.coupons WHERE store_id=$1 AND member_id=$2 AND id=$3', [storeId, member.id, receipt.couponId])).rows[0] : null;
            return { member: await this.memberView(client, member, now), coupon: coupon ? this.couponView(coupon, now) : null } as T;
          }
        }
        return previous.response;
      }
      const now = await this.now(client);
      const { result, memberId } = await action(client, store, now);
      // Durable effects, not repeated copies of a customer's entire history. A replay
      // reconstructs the current authorized member/coupon state without reapplying it.
      const receipt = memberId ? { format: 'member-effect-v1', couponId: (result as StampResult).coupon?.id ?? null } : result;
      await client.query('INSERT INTO tamaya.idempotency(store_id,actor_uid,key,fingerprint,member_id,response,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [storeId, mutation.actor.uid, mutation.idempotencyKey, mutation.fingerprint, memberId ?? null, JSON.stringify(receipt), now]);
      return result;
    });
  }

  async grantStamp(storeId: string, memberId: string, purchaseAmountYen: number, mutation: ProductionMutation): Promise<StampResult> {
    return this.mutate(storeId, mutation, async (client, store) => {
      this.ready(store.info.reward);
      this.purchase(purchaseAmountYen, store.info.reward.minimumPurchaseYen);
      const member = await this.member(client, storeId, memberId, true);
      const now = await this.now(client); // Take time after waiting for member lock, including JST midnight.
      const day = jstDate(now);
      if ((await client.query('SELECT 1 FROM tamaya.stamp_events WHERE store_id=$1 AND member_id=$2 AND japan_date=$3', [storeId, memberId, day])).rowCount) {
        throw failure('ALREADY_STAMPED', 409, '本日はすでにスタンプを付与しています。来店スタンプは日本時間で1日1回です。');
      }
      const policy = store.info.reward;
      const next = member.stamps + 1;
      let coupon: ServerCoupon | null = null;
      await client.query('INSERT INTO tamaya.stamp_events(id,store_id,member_id,japan_date,created_at,purchase_amount_yen) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), storeId, memberId, day, now, purchaseAmountYen]);
      member.stamps = next;
      if (next >= policy.stampsRequired) {
        member.stamps = next - policy.stampsRequired;
        const row = (await client.query<CouponRow>(
          'INSERT INTO tamaya.coupons(id,store_id,member_id,issued_at,expires_at,policy_version,benefit,eligible_products,combination_rule,redemption_minimum_purchase_yen) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [randomUUID(), storeId, memberId, now, new Date(now.getTime() + policy.validityDays * 86400_000), policy.version,
            JSON.stringify(policy.benefit), JSON.stringify(policy.eligibleProducts), policy.combinationRule, policy.redemptionMinimumPurchaseYen])).rows[0];
        coupon = this.couponView(row, now);
        await this.log(client, storeId, mutation.actor.uid, 'coupon.issue', row.id, now, memberId, purchaseAmountYen);
      }
      await client.query('UPDATE tamaya.members SET stamps=$3 WHERE store_id=$1 AND id=$2', [storeId, memberId, member.stamps]);
      await this.log(client, storeId, mutation.actor.uid, 'stamp.grant', memberId, now, memberId, purchaseAmountYen);
      return { result: { member: await this.memberView(client, member, now), coupon }, memberId };
    });
  }

  async redeemCoupon(storeId: string, couponId: string, purchaseAmountYen: number, mutation: ProductionMutation): Promise<CouponResult> {
    return this.mutate(storeId, mutation, async (client, store) => {
      this.ready(store.info.reward);
      if (!/^[0-9a-f-]{36}$/i.test(couponId)) throw failure('COUPON_NOT_FOUND', 404, '特典が見つかりません。');
      // Locate first, then lock member before coupon, matching grant's lock order.
      const found = (await client.query<CouponRow>('SELECT * FROM tamaya.coupons WHERE store_id=$1 AND id=$2', [storeId, couponId])).rows[0];
      if (!found?.member_id) throw failure('COUPON_NOT_FOUND', 404, '特典が見つかりません。');
      const member = await this.member(client, storeId, found.member_id, true);
      const coupon = (await client.query<CouponRow>('SELECT * FROM tamaya.coupons WHERE store_id=$1 AND id=$2 AND member_id=$3 FOR UPDATE', [storeId, couponId, member.id])).rows[0];
      this.purchase(purchaseAmountYen, coupon.redemption_minimum_purchase_yen);
      const now = await this.now(client);
      if (coupon.used_at) throw failure('COUPON_USED', 409, 'この特典は使用済みです。');
      if (coupon.expires_at.getTime() <= now.getTime()) throw failure('COUPON_EXPIRED', 409, 'この特典は有効期限を過ぎています。');
      await client.query('UPDATE tamaya.coupons SET used_at=$3,used_purchase_amount_yen=$4 WHERE store_id=$1 AND id=$2 AND used_at IS NULL AND expires_at>$3', [storeId, couponId, now, purchaseAmountYen]);
      coupon.used_at = now;
      await this.log(client, storeId, mutation.actor.uid, 'coupon.redeem', couponId, now, member.id, purchaseAmountYen);
      return { result: { member: await this.memberView(client, member, now), coupon: this.couponView(coupon, now) }, memberId: member.id };
    });
  }

  async listNotices(storeId: string): Promise<ServerNotice[]> {
    await this.store(this.pool, storeId);
    return (await this.pool.query<{ id: string; title: string; body: string; updated_at: Date }>('SELECT id,title,body,updated_at FROM tamaya.notices WHERE store_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100', [storeId])).rows
      .map((row) => ({ id: row.id, title: row.title, body: row.body, updatedAt: iso(row.updated_at) }));
  }

  async saveNotice(storeId: string, input: { id?: string; title: string; body: string }, mutation: ProductionMutation): Promise<ServerNotice> {
    if (!input.title?.trim() || input.title.trim().length > 80 || !input.body?.trim() || input.body.trim().length > 1000) {
      throw failure('INVALID_NOTICE', 400, 'お知らせは見出し1〜80文字、本文1〜1000文字で入力してください。');
    }
    return this.mutate(storeId, mutation, async (client, _store, now) => {
      const id = input.id ?? randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw failure('NOTICE_NOT_FOUND', 404, 'お知らせが見つかりません。');
      if (input.id) {
        const changed = await client.query('UPDATE tamaya.notices SET title=$3,body=$4,updated_at=$5 WHERE store_id=$1 AND id=$2', [storeId, id, input.title.trim(), input.body.trim(), now]);
        if (!changed.rowCount) throw failure('NOTICE_NOT_FOUND', 404, 'お知らせが見つかりません。');
      } else {
        await client.query('INSERT INTO tamaya.notices(id,store_id,title,body,updated_at) VALUES($1,$2,$3,$4,$5)', [id, storeId, input.title.trim(), input.body.trim(), now]);
      }
      await this.log(client, storeId, mutation.actor.uid, input.id ? 'notice.update' : 'notice.create', id, now);
      return { result: { id, title: input.title.trim(), body: input.body.trim(), updatedAt: iso(now) } };
    });
  }

  async stats(storeId: string, actor: ProductionIdentity): Promise<StoreStats> {
    return this.tx(async (client) => {
      await this.staff(client, await this.store(client, storeId), actor);
      const day = jstDate(await this.now(client));
      const { rows } = await client.query<{ members: number; stamps: number; redemptions: number }>(
        `SELECT (SELECT count(*)::int FROM tamaya.members WHERE store_id=$1 AND state='active') AS members,
          (SELECT count(*)::int FROM tamaya.stamp_events WHERE store_id=$1 AND japan_date=$2) AS stamps,
          (SELECT count(*)::int FROM tamaya.coupons WHERE store_id=$1 AND (used_at AT TIME ZONE 'Asia/Tokyo')::date=$2) AS redemptions`, [storeId, day]);
      return { members: rows[0].members, stampsToday: rows[0].stamps, redemptionsToday: rows[0].redemptions };
    });
  }

  async listStaff(storeId: string, actor: ProductionIdentity): Promise<StaffAccount[]> {
    return this.tx(async (client) => {
      await this.staff(client, await this.store(client, storeId), actor, true);
      return (await client.query<StaffAccount>('SELECT uid,role,active FROM tamaya.staff WHERE store_id=$1 ORDER BY created_at,uid', [storeId])).rows;
    });
  }

  async setStaff(storeId: string, targetUid: string, role: StaffRole, active: boolean, mutation: ProductionMutation): Promise<StaffAccount> {
    if (!validUid(targetUid) || !['staff', 'owner'].includes(role) || typeof active !== 'boolean') throw failure('INVALID_STAFF', 400, 'スタッフの設定を確認してください。');
    return this.mutate(storeId, mutation, async (client, store, now) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`register:${store.firebase_project_id}:${targetUid}`]);
      if ((await client.query('SELECT 1 FROM tamaya.deletion_jobs WHERE firebase_project_id=$1 AND uid=$2 AND state=\'pending\'', [store.firebase_project_id, targetUid])).rowCount) {
        throw failure('ACCOUNT_DELETING', 409, '退会処理中のアカウントには権限を設定できません。');
      }
      if (active && !(await client.query('SELECT 1 FROM tamaya.members WHERE store_id=$1 AND uid=$2 AND state=\'active\' FOR SHARE', [storeId, targetUid])).rowCount) {
        throw failure('STAFF_MEMBER_REQUIRED', 409, '追加・有効化するスタッフは、先にこの店舗でメール確認と会員登録を完了してください。');
      }
      const existing = (await client.query<StaffAccount>('SELECT uid,role,active FROM tamaya.staff WHERE store_id=$1 AND uid=$2 FOR UPDATE', [storeId, targetUid])).rows[0];
      if (!active && !existing) throw failure('STAFF_NOT_FOUND', 404, '停止対象のスタッフが見つかりません。');
      if (existing?.role === 'owner' && existing.active && (!active || role !== 'owner')) {
        const count = (await client.query<{ count: number }>('SELECT count(*)::int FROM tamaya.staff WHERE store_id=$1 AND role=\'owner\' AND active=true', [storeId])).rows[0].count;
        if (count <= 1) throw failure('LAST_OWNER', 409, '最後のオーナーは停止・変更できません。別のオーナーを追加してください。');
      }
      await client.query('INSERT INTO tamaya.staff(store_id,uid,role,active) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,uid) DO UPDATE SET role=EXCLUDED.role,active=EXCLUDED.active', [storeId, targetUid, role, active]);
      await this.log(client, storeId, mutation.actor.uid, active ? 'staff.activate' : 'staff.deactivate', targetUid, now);
      return { result: { uid: targetUid, role, active } };
    }, true);
  }

  async audit(storeId: string, actor: ProductionIdentity): Promise<AuditRecord[]> {
    return this.tx(async (client) => {
      await this.staff(client, await this.store(client, storeId), actor, true);
      return (await client.query<{ id: string; actor_uid: string; action: string; target_id: string; created_at: Date; purchase_amount_yen: number | null }>('SELECT id,actor_uid,action,target_id,created_at,purchase_amount_yen FROM tamaya.audit_log WHERE store_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [storeId])).rows
        .map((row) => ({ id: row.id, actorUid: row.actor_uid, action: row.action, targetId: row.target_id, createdAt: iso(row.created_at), purchaseAmountYen: row.purchase_amount_yen }));
    });
  }

  async requestDeletion(storeId: string, actor: ProductionIdentity): Promise<AccountDeletion> {
    return this.tx(async (client) => {
      const store = await this.store(client, storeId, 'update');
      // Deletion replays can be accepted while pending, unlike ordinary authenticated reads.
      // An unverified signup must also be able to erase its Firebase account.
      // Email verification stays mandatory for every ordinary membership operation.
      if (!validUid(actor.uid) || actor.projectId !== store.firebase_project_id) throw failure('UNAUTHENTICATED', 401, 'ログインを確認してください。');
      const now = await this.now(client);
      if (!Number.isFinite(actor.authTime) || now.getTime() / 1000 - actor.authTime > 300 || actor.authTime * 1000 > now.getTime() + 60_000) {
        throw failure('RECENT_LOGIN_REQUIRED', 401, '安全のため、もう一度パスワードを入力して退会してください。');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`register:${actor.projectId}:${actor.uid}`]);
      if ((await client.query('SELECT 1 FROM tamaya.staff s JOIN tamaya.stores t ON t.id=s.store_id WHERE t.firebase_project_id=$1 AND s.uid=$2 AND s.active=true', [actor.projectId, actor.uid])).rowCount) {
        throw failure('STAFF_ACCOUNT_ACTIVE', 409, 'スタッフ・オーナー権限を停止してから退会してください。最後のオーナーは先に引き継ぎが必要です。');
      }
      await client.query('INSERT INTO tamaya.deletion_jobs(id,firebase_project_id,uid) VALUES($1,$2,$3) ON CONFLICT(firebase_project_id,uid) WHERE state=\'pending\' DO NOTHING', [randomUUID(), actor.projectId, actor.uid]);
      await client.query('UPDATE tamaya.members m SET state=\'deletion_pending\' FROM tamaya.stores s WHERE m.store_id=s.id AND s.firebase_project_id=$1 AND m.uid=$2', [actor.projectId, actor.uid]);
      await this.log(client, storeId, actor.uid, 'account.deletion.request', actor.uid, now);
      return { status: 'pending' };
    });
  }

  async pendingDeletions(projectId?: string): Promise<DeletionJob[]> {
    return (await this.pool.query<{ id: string; uid: string; firebase_project_id: string }>('SELECT id,uid,firebase_project_id FROM tamaya.deletion_jobs WHERE state=\'pending\' AND ($1::text IS NULL OR firebase_project_id=$1) ORDER BY requested_at LIMIT 20', [projectId ?? null])).rows
      .map((row) => ({ id: row.id, uid: row.uid, projectId: row.firebase_project_id }));
  }

  async deletionStatus(projectId: string, uid: string): Promise<'pending' | 'completed'> {
    const pending = await this.pool.query('SELECT 1 FROM tamaya.deletion_jobs WHERE firebase_project_id=$1 AND uid=$2 AND state=\'pending\'', [projectId, uid]);
    return pending.rowCount ? 'pending' : 'completed';
  }

  async completeDeletion(jobId: string): Promise<void> {
    await this.tx(async (client) => {
      const found = (await client.query<{ id: string; uid: string | null; firebase_project_id: string; state: string }>('SELECT * FROM tamaya.deletion_jobs WHERE id=$1', [jobId])).rows[0];
      if (!found || found.state === 'completed' || !found.uid) return;
      const stores = (await client.query<{ id: string }>('SELECT id FROM tamaya.stores WHERE firebase_project_id=$1 ORDER BY id FOR UPDATE', [found.firebase_project_id])).rows.map((row) => row.id);
      const job = (await client.query<{ id: string; uid: string | null; firebase_project_id: string; state: string }>('SELECT * FROM tamaya.deletion_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      if (!job || job.state === 'completed' || !job.uid) return;
      const members = (await client.query<{ id: string }>('SELECT id FROM tamaya.members WHERE store_id=ANY($1) AND uid=$2 FOR UPDATE', [stores, job.uid])).rows.map((row) => row.id);
      // Remove cached JSON snapshots and identity references, retain only anonymous operation counts.
      await client.query('DELETE FROM tamaya.idempotency WHERE store_id=ANY($1) AND (actor_uid=$2 OR member_id=ANY($3::uuid[]) OR response->>\'uid\'=$2)', [stores, job.uid, members]);
      await client.query('UPDATE tamaya.audit_log SET target_id=\'deleted\' WHERE store_id=ANY($1) AND (member_id=ANY($2::uuid[]) OR target_id=$3)', [stores, members, job.uid]);
      await client.query('UPDATE tamaya.audit_log SET actor_uid=\'deleted\' WHERE store_id=ANY($1) AND actor_uid=$2', [stores, job.uid]);
      await client.query('DELETE FROM tamaya.members WHERE store_id=ANY($1) AND uid=$2', [stores, job.uid]);
      await client.query('DELETE FROM tamaya.staff WHERE store_id=ANY($1) AND uid=$2', [stores, job.uid]);
      await client.query('UPDATE tamaya.deletion_jobs SET uid=NULL,state=\'completed\',completed_at=$2 WHERE id=$1', [job.id, await this.now(client)]);
    });
  }
}
