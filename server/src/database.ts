import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  DomainError,
  type AuditEntry, type CouponRecord, type DatabasePort, type GrantResult, type Identity,
  type MemberSummary, type MemberView, type Mutation, type Notice, type RedeemResult,
  type Staff, type StaffRole, type StampRecord, type Stats, type Store,
} from './types.js';

type Row = Record<string, string | number | bigint | null | Uint8Array>;
const DAY_MS = 86_400_000;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;

function japanDate(date: Date): string {
  return new Date(date.getTime() + JAPAN_OFFSET_MS).toISOString().slice(0, 10);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new DomainError('INVALID_INPUT', 400, `${label}を1〜${max}文字で入力してください。`);
  }
  return value.trim();
}

function validUid(uid: string): string {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.trim() !== uid) {
    throw new DomainError('INVALID_UID', 400, 'ユーザーIDを確認してください。');
  }
  return uid;
}

/** A durable, single-server repository. Callers never submit a replacement database snapshot. */
export class ServerDatabase implements DatabasePort {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.now = options.now ?? (() => new Date());
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const sql = readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
    this.transaction(() => {
      this.db.exec(sql);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)')
        .run(this.timestamp());
    });
  }

  close(): void { this.db.close(); }

  createStore(input: Store): Store {
    const id = text(input.id, '店舗ID', 80);
    const name = text(input.name, '店舗名', 80);
    const projectId = text(input.firebaseProjectId, 'FirebaseプロジェクトID', 128);
    if (![input.stampsRequired, input.discountYen, input.validityDays].every(Number.isInteger)
      || input.stampsRequired < 1 || input.stampsRequired > 1000
      || input.discountYen < 1 || input.discountYen > 1_000_000
      || input.validityDays < 1 || input.validityDays > 3650) {
      throw new DomainError('INVALID_STORE', 400, '店舗の特典条件を確認してください。');
    }
    return this.transaction(() => {
      const existing = this.one('SELECT * FROM stores WHERE id = ?', id);
      if (existing) {
        if (existing.firebase_project_id !== projectId) {
          throw new DomainError('STORE_PROJECT_CONFLICT', 409, '登録済み店舗のFirebaseプロジェクトは変更できません。');
        }
        // A normal restart must not silently replace persisted reward conditions.
        return this.store(existing);
      }
      this.db.prepare(`INSERT INTO stores
        (id, name, firebase_project_id, stamps_required, discount_yen, validity_days, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, name, projectId,
        input.stampsRequired, input.discountYen, input.validityDays, this.timestamp());
      return this.getStore(id);
    });
  }

  getStore(storeId: string): Store {
    const row = this.one('SELECT * FROM stores WHERE id = ?', storeId);
    if (!row) throw new DomainError('STORE_NOT_FOUND', 404, '店舗が見つかりません。');
    return this.store(row);
  }

  /** Trusted local administration command only; never exposed as an unauthenticated HTTP route. */
  bootstrapOwner(storeId: string, uid: string): void {
    this.getStore(storeId); validUid(uid);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO staff(store_id, uid, role, active, updated_at)
        VALUES (?, ?, 'owner', 1, ?) ON CONFLICT(store_id, uid)
        DO UPDATE SET role = 'owner', active = 1, updated_at = excluded.updated_at`)
        .run(storeId, uid, this.timestamp());
      this.recordAudit(storeId, 'system:bootstrap', 'owner.bootstrap', uid);
    });
  }

  registerMember(storeId: string, identity: Identity, nickname: string): MemberView {
    this.requireIdentity(storeId, identity);
    const name = text(nickname, 'ニックネーム', 20);
    return this.transaction(() => {
      const existing = this.one('SELECT id FROM members WHERE store_id = ? AND uid = ?', storeId, identity.uid);
      if (existing) return this.getMember(storeId, String(existing.id));
      const next = this.one('SELECT COALESCE(MAX(CAST(number AS INTEGER)), 0) + 1 AS next FROM members WHERE store_id = ?', storeId);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO members(id, store_id, uid, number, nickname, stamps, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .run(id, storeId, identity.uid, String(next!.next).padStart(6, '0'), name, this.timestamp());
      this.recordAudit(storeId, identity.uid, 'member.register', id);
      return this.getMember(storeId, id);
    });
  }

  getOwnMember(storeId: string, identity: Identity): MemberView {
    this.requireIdentity(storeId, identity);
    const row = this.one('SELECT id FROM members WHERE store_id = ? AND uid = ?', storeId, identity.uid);
    if (!row) throw new DomainError('MEMBER_NOT_FOUND', 404, '会員登録が必要です。');
    return this.getMember(storeId, String(row.id));
  }

  getMember(storeId: string, memberId: string): MemberView {
    this.getStore(storeId);
    const row = this.one('SELECT * FROM members WHERE store_id = ? AND id = ?', storeId, memberId);
    if (!row) throw new DomainError('MEMBER_NOT_FOUND', 404, '会員が見つかりません。');
    return {
      id: String(row.id), storeId, number: String(row.number), nickname: String(row.nickname),
      stamps: Number(row.stamps), createdAt: String(row.created_at),
      stampHistory: this.all(`SELECT * FROM stamp_events WHERE store_id = ? AND member_id = ?
        ORDER BY created_at DESC, id`, storeId, memberId).map((stamp) => this.stamp(stamp)),
      coupons: this.all(`SELECT * FROM coupons WHERE store_id = ? AND member_id = ?
        ORDER BY issued_at DESC, id`, storeId, memberId).map((coupon) => this.coupon(coupon)),
    };
  }

  listMembers(storeId: string, query = ''): MemberSummary[] {
    this.getStore(storeId);
    const search = query.trim().slice(0, 80);
    // Escaping means '%' and '_' in a nickname are literal characters, not wildcards.
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.all(`SELECT id, number, nickname, stamps FROM members WHERE store_id = ?
      AND (nickname LIKE ? ESCAPE '\\' OR number LIKE ? ESCAPE '\\')
      ORDER BY created_at DESC, id LIMIT 20`, storeId, like, like).map((row) => ({
      id: String(row.id), number: String(row.number), nickname: String(row.nickname), stamps: Number(row.stamps),
    }));
  }

  getStaff(storeId: string, identity: Identity): Staff | null {
    this.requireIdentity(storeId, identity);
    const row = this.one('SELECT * FROM staff WHERE store_id = ? AND uid = ?', storeId, identity.uid);
    return row ? this.staff(row) : null;
  }

  listStaff(storeId: string, actor: Identity): Staff[] {
    this.requireStaff(storeId, actor, true);
    return this.all('SELECT * FROM staff WHERE store_id = ? ORDER BY uid', storeId).map((row) => this.staff(row));
  }

  setStaff(storeId: string, targetUid: string, role: StaffRole, active: boolean, mutation: Mutation): Staff {
    validUid(targetUid);
    if (!['owner', 'staff'].includes(role) || typeof active !== 'boolean') {
      throw new DomainError('INVALID_STAFF', 400, 'スタッフの権限と有効状態を確認してください。');
    }
    return this.mutate(storeId, mutation, true, () => {
      const previous = this.one('SELECT * FROM staff WHERE store_id = ? AND uid = ?', storeId, targetUid);
      if (previous?.role === 'owner' && previous.active === 1 && (role !== 'owner' || !active)) {
        const owners = Number(this.one("SELECT COUNT(*) AS count FROM staff WHERE store_id = ? AND role = 'owner' AND active = 1", storeId)!.count);
        if (owners <= 1) throw new DomainError('LAST_OWNER', 409, '最後の有効な管理者は停止・降格できません。');
      }
      this.db.prepare(`INSERT INTO staff(store_id, uid, role, active, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(store_id, uid) DO UPDATE SET role = excluded.role, active = excluded.active,
        updated_at = excluded.updated_at`).run(storeId, targetUid, role, active ? 1 : 0, this.timestamp());
      this.recordAudit(storeId, mutation.actor.uid, 'staff.change', targetUid, { role, active });
      return this.staff(this.one('SELECT * FROM staff WHERE store_id = ? AND uid = ?', storeId, targetUid)!);
    });
  }

  grantStamp(storeId: string, memberId: string, mutation: Mutation): GrantResult {
    return this.mutate(storeId, mutation, false, () => {
      const store = this.getStore(storeId);
      const member = this.getMember(storeId, memberId);
      const now = this.currentTime();
      const today = japanDate(now);
      if (this.one('SELECT id FROM stamp_events WHERE store_id = ? AND member_id = ? AND japan_date = ?', storeId, memberId, today)) {
        throw new DomainError('ALREADY_STAMPED', 409, '本日は付与済みです。日本時間で1日1回までです。');
      }
      const stamp: StampRecord = { id: randomUUID(), memberId, createdAt: now.toISOString(), japanDate: today };
      this.db.prepare(`INSERT INTO stamp_events(id, store_id, member_id, actor_uid, created_at, japan_date, source)
        VALUES (?, ?, ?, ?, ?, ?, 'visit')`).run(stamp.id, storeId, memberId, mutation.actor.uid, stamp.createdAt, today);
      let balance = member.stamps + 1;
      let couponId: string | null = null;
      if (balance >= store.stampsRequired) {
        balance -= store.stampsRequired;
        couponId = randomUUID();
        this.db.prepare(`INSERT INTO coupons(id, store_id, member_id, discount_yen, stamps_required,
          validity_days, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(couponId, storeId, memberId, store.discountYen, store.stampsRequired, store.validityDays,
            now.toISOString(), new Date(now.getTime() + store.validityDays * DAY_MS).toISOString());
      }
      this.db.prepare('UPDATE members SET stamps = ? WHERE store_id = ? AND id = ?').run(balance, storeId, memberId);
      this.recordAudit(storeId, mutation.actor.uid, 'stamp.grant', memberId,
        { stampId: stamp.id, couponId, balance });
      const updated = this.getMember(storeId, memberId);
      return { member: updated, stamp, coupon: couponId ? updated.coupons.find((coupon) => coupon.id === couponId)! : null };
    });
  }

  redeemCoupon(storeId: string, couponId: string, mutation: Mutation): RedeemResult {
    return this.mutate(storeId, mutation, false, () => {
      const row = this.one('SELECT * FROM coupons WHERE store_id = ? AND id = ?', storeId, couponId);
      if (!row) throw new DomainError('COUPON_NOT_FOUND', 404, 'クーポンが見つかりません。');
      const now = this.currentTime();
      if (row.used_at !== null) throw new DomainError('COUPON_USED', 409, 'このクーポンは使用済みです。');
      if (now.getTime() >= Date.parse(String(row.expires_at))) {
        throw new DomainError('COUPON_EXPIRED', 409, 'このクーポンは期限切れです。');
      }
      if (now.getTime() < Date.parse(String(row.issued_at))) {
        throw new DomainError('COUPON_NOT_ACTIVE', 409, '発行前のクーポンは使用できません。');
      }
      const result = this.db.prepare(`UPDATE coupons SET used_at = ?, used_by = ?
        WHERE store_id = ? AND id = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now.toISOString(), mutation.actor.uid, storeId, couponId, now.toISOString());
      if (Number(result.changes) !== 1) throw new DomainError('COUPON_CONFLICT', 409, 'クーポンの状態が変わりました。再確認してください。');
      this.recordAudit(storeId, mutation.actor.uid, 'coupon.redeem', couponId);
      const member = this.getMember(storeId, String(row.member_id));
      return { member, coupon: member.coupons.find((coupon) => coupon.id === couponId)! };
    });
  }

  listNotices(storeId: string): Notice[] {
    this.getStore(storeId);
    return this.all('SELECT * FROM notices WHERE store_id = ? ORDER BY updated_at DESC, id', storeId)
      .map((row) => this.notice(row));
  }

  saveNotice(storeId: string, input: { id?: string; title: string; body: string }, mutation: Mutation): Notice {
    const title = text(input.title, 'お知らせのタイトル', 80);
    const body = text(input.body, 'お知らせの本文', 1000);
    return this.mutate(storeId, mutation, false, () => {
      const now = this.timestamp();
      let id = input.id;
      if (id) {
        const row = this.one('SELECT id FROM notices WHERE store_id = ? AND id = ?', storeId, id);
        if (!row) throw new DomainError('NOTICE_NOT_FOUND', 404, 'お知らせが見つかりません。');
        this.db.prepare('UPDATE notices SET title = ?, body = ?, updated_at = ? WHERE store_id = ? AND id = ?')
          .run(title, body, now, storeId, id);
      } else {
        id = randomUUID();
        this.db.prepare('INSERT INTO notices(id, store_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, storeId, title, body, now, now);
      }
      this.recordAudit(storeId, mutation.actor.uid, input.id ? 'notice.update' : 'notice.create', id);
      return this.notice(this.one('SELECT * FROM notices WHERE store_id = ? AND id = ?', storeId, id)!);
    });
  }

  stats(storeId: string): Stats {
    this.getStore(storeId);
    const today = japanDate(this.currentTime());
    const start = Date.parse(`${today}T00:00:00+09:00`);
    const startIso = new Date(start).toISOString();
    const endIso = new Date(start + DAY_MS).toISOString();
    return {
      members: Number(this.one('SELECT COUNT(*) AS count FROM members WHERE store_id = ?', storeId)!.count),
      stampsToday: Number(this.one('SELECT COUNT(*) AS count FROM stamp_events WHERE store_id = ? AND japan_date = ?', storeId, today)!.count),
      redemptionsToday: Number(this.one('SELECT COUNT(*) AS count FROM coupons WHERE store_id = ? AND used_at >= ? AND used_at < ?', storeId, startIso, endIso)!.count),
    };
  }

  audit(storeId: string, actor: Identity): AuditEntry[] {
    this.requireStaff(storeId, actor, true);
    return this.all('SELECT * FROM audit_log WHERE store_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100', storeId)
      .map((row) => ({ id: String(row.id), storeId, actorUid: String(row.actor_uid),
        action: String(row.action), targetId: String(row.target_id), createdAt: String(row.created_at) }));
  }

  seedDemo(): { storeId: string; memberId: string } {
    const storeId = 'tamaya';
    const projectId = 'demo-tamaya';
    this.createStore({ id: storeId, name: 'むさしの玉屋', firebaseProjectId: projectId,
      stampsRequired: 10, discountYen: 100, validityDays: 30 });
    return this.transaction(() => {
      const existing = this.one('SELECT id FROM members WHERE store_id = ? AND uid = ?', storeId, 'demo-customer');
      if (existing) return { storeId, memberId: String(existing.id) };
      const now = this.currentTime();
      const created = new Date(now.getTime() - 60 * DAY_MS).toISOString();
      for (const [uid, role] of [['demo-owner', 'owner'], ['demo-staff', 'staff']] as const) {
        this.db.prepare('INSERT OR IGNORE INTO staff(store_id, uid, role, active, updated_at) VALUES (?, ?, ?, 1, ?)')
          .run(storeId, uid, role, now.toISOString());
      }
      const memberId = randomUUID();
      const next = this.one('SELECT COALESCE(MAX(CAST(number AS INTEGER)), 0) + 1 AS next FROM members WHERE store_id = ?', storeId);
      this.db.prepare('INSERT INTO members(id, store_id, uid, number, nickname, stamps, created_at) VALUES (?, ?, ?, ?, ?, 9, ?)')
        .run(memberId, storeId, 'demo-customer', String(next!.next).padStart(6, '0'), '体験用の会員', created);
      const midnight = Date.parse(`${japanDate(now)}T00:00:00+09:00`);
      for (let index = 1; index <= 9; index += 1) {
        const when = new Date(midnight - index * DAY_MS + 12 * 60 * 60 * 1000);
        this.db.prepare(`INSERT INTO stamp_events(id, store_id, member_id, actor_uid, created_at, japan_date, source)
          VALUES (?, ?, ?, 'system:sample', ?, ?, 'sample')`)
          .run(randomUUID(), storeId, memberId, when.toISOString(), japanDate(when));
      }
      for (const used of [false, true]) {
        this.db.prepare(`INSERT INTO coupons(id, store_id, member_id, discount_yen, stamps_required,
          validity_days, issued_at, expires_at, used_at, used_by) VALUES (?, ?, ?, 100, 10, 30, ?, ?, ?, ?)`)
          .run(randomUUID(), storeId, memberId,
            new Date(now.getTime() - 45 * DAY_MS).toISOString(), new Date(now.getTime() - 15 * DAY_MS).toISOString(),
            used ? new Date(now.getTime() - 30 * DAY_MS).toISOString() : null, used ? 'system:sample' : null);
      }
      this.db.prepare('INSERT INTO notices(id, store_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), storeId, '管理サーバーの動作確認', '架空の会員データを使う試用環境です。実店舗では利用できません。', now.toISOString(), now.toISOString());
      return { storeId, memberId };
    });
  }

  private store(row: Row): Store {
    return { id: String(row.id), name: String(row.name), firebaseProjectId: String(row.firebase_project_id),
      stampsRequired: Number(row.stamps_required), discountYen: Number(row.discount_yen), validityDays: Number(row.validity_days) };
  }
  private staff(row: Row): Staff {
    return { uid: String(row.uid), storeId: String(row.store_id), role: row.role as StaffRole, active: row.active === 1 };
  }
  private stamp(row: Row): StampRecord {
    return { id: String(row.id), memberId: String(row.member_id), createdAt: String(row.created_at), japanDate: String(row.japan_date) };
  }
  private coupon(row: Row): CouponRecord {
    return { id: String(row.id), storeId: String(row.store_id), memberId: String(row.member_id),
      issuedAt: String(row.issued_at), expiresAt: String(row.expires_at), usedAt: row.used_at === null ? null : String(row.used_at),
      discountYen: Number(row.discount_yen), stampsRequired: Number(row.stamps_required),
      status: row.used_at !== null ? 'used' : this.currentTime().getTime() >= Date.parse(String(row.expires_at)) ? 'expired' : 'available' };
  }
  private notice(row: Row): Notice {
    return { id: String(row.id), storeId: String(row.store_id), title: String(row.title), body: String(row.body), updatedAt: String(row.updated_at) };
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private currentTime(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new DomainError('INVALID_CLOCK', 500, 'サーバーの日時を確認してください。');
    return now;
  }
  private timestamp(): string { return this.currentTime().toISOString(); }
  private requireIdentity(storeId: string, identity: Identity): void {
    validUid(identity.uid);
    if (this.getStore(storeId).firebaseProjectId !== identity.projectId) {
      throw new DomainError('PROJECT_MISMATCH', 403, 'この店舗の認証情報ではありません。');
    }
  }
  private requireStaff(storeId: string, identity: Identity, ownerOnly = false): Staff {
    const staff = this.getStaff(storeId, identity);
    if (!staff?.active || (ownerOnly && staff.role !== 'owner')) {
      throw new DomainError('FORBIDDEN', 403, ownerOnly ? '店舗管理者の権限が必要です。' : '有効なスタッフ権限が必要です。');
    }
    return staff;
  }
  private mutate<T>(storeId: string, mutation: Mutation, ownerOnly: boolean, action: () => T): T {
    if (typeof mutation.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(mutation.idempotencyKey)
      || typeof mutation.fingerprint !== 'string' || !mutation.fingerprint || mutation.fingerprint.length > 512) {
      throw new DomainError('INVALID_IDEMPOTENCY', 400, '操作の識別子を確認してください。');
    }
    return this.transaction(() => {
      // Check the current role even for a cached result: revoked staff cannot replay protected data.
      this.requireStaff(storeId, mutation.actor, ownerOnly);
      const previous = this.one('SELECT * FROM idempotency WHERE store_id = ? AND actor_uid = ? AND request_key = ?',
        storeId, mutation.actor.uid, mutation.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== mutation.fingerprint) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 409, '同じ操作IDが別の内容に使われています。');
        }
        return JSON.parse(String(previous.response_json)) as T;
      }
      const result = action();
      this.db.prepare(`INSERT INTO idempotency(store_id, actor_uid, request_key, fingerprint, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(storeId, mutation.actor.uid, mutation.idempotencyKey, mutation.fingerprint, JSON.stringify(result), this.timestamp());
      return result;
    });
  }
  private recordAudit(storeId: string, actorUid: string, action: string, targetId: string, details: unknown = {}): void {
    const now = this.currentTime();
    this.db.prepare(`INSERT INTO audit_log(id, store_id, actor_uid, action, target_id, details_json, created_at, japan_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), storeId, actorUid, action, targetId, JSON.stringify(details), now.toISOString(), japanDate(now));
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
