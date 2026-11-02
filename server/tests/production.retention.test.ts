import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresDatabase } from '../src/production/database.js';
import type { StoreInfo } from '../../shared/contracts.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('detached withdrawal records expire after 90 days (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const now = new Date('2026-11-02T03:00:00.000Z');
  const cutoff = new Date(now.getTime() - 90 * 86400_000);
  const older = new Date(cutoff.getTime() - 1);
  const newer = new Date(cutoff.getTime() + 1);
  const db = new PostgresDatabase(pool, { now: () => now });
  beforeAll(async () => { await db.migrate(); }, 30_000);
  afterAll(async () => { await db.close(); });

  async function fixture(projectId?: string) {
    const id = `ret-${randomUUID().slice(0, 12)}`;
    const project = projectId ?? `demo-${id}`;
    const store: StoreInfo = {
      id, name: '検証専用架空店舗', area: 'テスト', address: null, phone: null, hours: null, informationSource: null,
      products: [], operator: { name: '検証用', phone: '000', email: null },
      reward: { version: 'test-1', stampsRequired: 5, validityDays: 90, dailyLimit: 1, timeZone: 'Asia/Tokyo',
        minimumPurchaseYen: 500, redemptionMinimumPurchaseYen: 0, benefit: { kind: 'item', label: '検証用' },
        eligibleProducts: ['検証用'], combinationRule: '検証用', operationsEnabled: true },
      legal: { termsVersion: 'test-terms', privacyVersion: 'test-privacy', termsText: 'テスト', privacyText: 'テスト', supportText: 'テスト', privacyUrl: null, supportUrl: null },
    };
    await db.upsertStore(store, project);
    return { id, project, store };
  }

  async function member(f: Awaited<ReturnType<typeof fixture>>, state: 'active' | 'deletion_pending' = 'active', uid = randomUUID()) {
    const value = await db.register(f.id, { uid, projectId: f.project, emailVerified: true, authTime: now.getTime() / 1000 }, {
      nickname: '検証会員', acceptedTermsVersion: f.store.legal.termsVersion, acceptedPrivacyVersion: f.store.legal.privacyVersion,
    });
    if (state === 'deletion_pending') await pool.query("UPDATE tamaya.members SET state='deletion_pending' WHERE id=$1", [value.id]);
    return value;
  }

  async function records(f: Awaited<ReturnType<typeof fixture>>, at: Date, memberId: string | null = null, actor = 'deleted', target = 'deleted') {
    const stamp = randomUUID(), coupon = randomUUID(), audit = randomUUID();
    await pool.query('INSERT INTO tamaya.stamp_events(id,store_id,member_id,japan_date,created_at,purchase_amount_yen) VALUES($1,$2,$3,$4,$5,500)', [stamp, f.id, memberId, at.toISOString().slice(0, 10), at]);
    await pool.query(`INSERT INTO tamaya.coupons(id,store_id,member_id,issued_at,expires_at,policy_version,benefit,eligible_products,combination_rule)
      VALUES($1,$2,$3,$4,$5,'test-1','{"kind":"item","label":"検証用"}'::jsonb,'["検証用"]'::jsonb,'検証用')`,
    [coupon, f.id, memberId, at, new Date(at.getTime() + 90 * 86400_000)]);
    await pool.query(`INSERT INTO tamaya.audit_log(id,store_id,member_id,actor_uid,action,target_id,created_at,purchase_amount_yen)
      VALUES($1,$2,$3,$4,'stamp.grant',$5,$6,500)`, [audit, f.id, memberId, actor, target, at]);
    return { stamp, coupon, audit };
  }

  async function job(project: string, completedAt: Date | null, state: 'pending' | 'completed' = 'completed') {
    const id = randomUUID();
    await pool.query(`INSERT INTO tamaya.deletion_jobs(id,firebase_project_id,uid,state,requested_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, project, state === 'pending' ? randomUUID() : null, state, older, completedAt]);
    return id;
  }

  async function present(table: 'stamp_events' | 'coupons' | 'audit_log' | 'deletion_jobs', ids: string[]) {
    return (await pool.query<{ id: string }>(`SELECT id FROM tamaya.${table} WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows.map((row) => row.id);
  }

  it('expires detached records at the exact elapsed 90-day boundary but preserves newer records', async () => {
    const f = await fixture();
    const old = await records(f, older), exact = await records(f, cutoff), recent = await records(f, newer);
    const jobs = [await job(f.project, older), await job(f.project, cutoff), await job(f.project, newer)];
    expect(await db.purgeDetachedRecords(f.id, f.project)).toEqual({ stampEvents: 2, coupons: 2, auditRecords: 2, deletionJobs: 2 });
    expect(await present('stamp_events', [old.stamp, exact.stamp, recent.stamp])).toEqual([recent.stamp]);
    expect(await present('coupons', [old.coupon, exact.coupon, recent.coupon])).toEqual([recent.coupon]);
    expect(await present('audit_log', [old.audit, exact.audit, recent.audit])).toEqual([recent.audit]);
    expect(await present('deletion_jobs', jobs)).toEqual([jobs[2]]);
    expect(await db.purgeDetachedRecords(f.id, f.project)).toEqual({ stampEvents: 0, coupons: 0, auditRecords: 0, deletionJobs: 0 });
  });

  it('preserves old records still attached to active or pending members and unrelated staff audits', async () => {
    const f = await fixture();
    const active = await member(f), pending = await member(f, 'deletion_pending');
    const activeRows = await records(f, older, active.id), pendingRows = await records(f, older, pending.id);
    const unrelated = randomUUID();
    await pool.query(`INSERT INTO tamaya.audit_log(id,store_id,actor_uid,action,target_id,created_at)
      VALUES($1,$2,'current-owner','notice.update',$3,$4)`, [unrelated, f.id, randomUUID(), older]);
    expect(await db.purgeDetachedRecords(f.id, f.project)).toEqual({ stampEvents: 0, coupons: 0, auditRecords: 0, deletionJobs: 0 });
    expect(await present('stamp_events', [activeRows.stamp, pendingRows.stamp])).toHaveLength(2);
    expect(await present('coupons', [activeRows.coupon, pendingRows.coupon])).toHaveLength(2);
    expect(await present('audit_log', [activeRows.audit, pendingRows.audit, unrelated])).toHaveLength(3);
    expect((await pool.query('SELECT id,state FROM tamaya.members WHERE id=ANY($1::uuid[])', [[active.id, pending.id]])).rowCount).toBe(2);
  });

  it('rejects a project mismatch and keeps other-store events and other-project jobs', async () => {
    const f = await fixture(), sameProject = await fixture(f.project), foreign = await fixture();
    const own = await records(f, older), other = await records(sameProject, older), elsewhere = await records(foreign, older);
    const ownJob = await job(f.project, older), foreignJob = await job(foreign.project, older);
    await expect(db.purgeDetachedRecords(f.id, foreign.project)).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    expect(await present('stamp_events', [own.stamp, other.stamp, elsewhere.stamp])).toHaveLength(3);
    expect(await db.purgeDetachedRecords(f.id, f.project)).toEqual({ stampEvents: 1, coupons: 1, auditRecords: 1, deletionJobs: 1 });
    expect(await present('stamp_events', [own.stamp, other.stamp, elsewhere.stamp])).toEqual([other.stamp, elsewhere.stamp].sort());
    expect(await present('coupons', [own.coupon, other.coupon, elsewhere.coupon])).toEqual([other.coupon, elsewhere.coupon].sort());
    expect(await present('audit_log', [own.audit, other.audit, elsewhere.audit])).toEqual([other.audit, elsewhere.audit].sort());
    expect(await present('deletion_jobs', [ownJob, foreignJob])).toEqual([foreignJob]);
  });

  it('never purges old pending jobs or completion records with unknown or recent completion time', async () => {
    const f = await fixture();
    const pending = await job(f.project, null, 'pending');
    const unknown = await job(f.project, null), recent = await job(f.project, now), expired = await job(f.project, older);
    expect((await db.purgeDetachedRecords(f.id, f.project)).deletionJobs).toBe(1);
    expect(await present('deletion_jobs', [pending, unknown, recent, expired])).toEqual([pending, unknown, recent].sort());
  });

  it('preserves ambiguous deleted markers when a real member or staff UID is literally deleted', async () => {
    const f = await fixture();
    await member(f, 'active', 'deleted');
    const asMember = await records(f, older);
    expect((await db.purgeDetachedRecords(f.id, f.project)).auditRecords).toBe(0);
    expect(await present('audit_log', [asMember.audit])).toEqual([asMember.audit]);
    const second = await fixture();
    await pool.query("INSERT INTO tamaya.staff(store_id,uid,role,active) VALUES($1,'deleted','owner',true)", [second.id]);
    const asStaff = await records(second, older, null, 'deleted', randomUUID());
    expect((await db.purgeDetachedRecords(second.id, second.project)).auditRecords).toBe(0);
    expect(await present('audit_log', [asStaff.audit])).toEqual([asStaff.audit]);
  });

  it('limits each run to a bounded batch and drains the remainder on the next run', async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO tamaya.stamp_events(id,store_id,japan_date,created_at,purchase_amount_yen)
      SELECT gen_random_uuid(),$1,'2026-01-01',$2,500 FROM generate_series(1,1001)`, [f.id, older]);
    expect((await db.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(1000);
    expect((await pool.query('SELECT 1 FROM tamaya.stamp_events WHERE store_id=$1', [f.id])).rowCount).toBe(1);
    expect((await db.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(1);
    expect((await db.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(0);
  });

  it('skips locked expired rows so other transactions do not stall maintenance', async () => {
    const f = await fixture(), row = await records(f, older);
    const client = await pool.connect();
    const bounded = new PostgresDatabase(new Pool({ connectionString: databaseUrl, options: '-c lock_timeout=500ms' }), { now: () => now });
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM tamaya.stamp_events WHERE id=$1 FOR UPDATE', [row.stamp]);
      expect((await bounded.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(0);
      expect(await present('stamp_events', [row.stamp])).toEqual([row.stamp]);
    } finally {
      await client.query('ROLLBACK'); client.release(); await bounded.close();
    }
    expect((await db.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(1);
  });

  it('rolls the whole maintenance transaction back when a later table deletion fails', async () => {
    const f = await fixture(), row = await records(f, older);
    const marker = 'retention_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE FUNCTION tamaya.${marker}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.store_id='${f.id}' THEN RAISE EXCEPTION 'retention-rollback-fixture'; END IF; RETURN OLD; END $$`);
    await pool.query(`CREATE TRIGGER ${marker} BEFORE DELETE ON tamaya.coupons FOR EACH ROW EXECUTE FUNCTION tamaya.${marker}()`);
    try {
      await expect(db.purgeDetachedRecords(f.id, f.project)).rejects.toThrow('retention-rollback-fixture');
      expect(await present('stamp_events', [row.stamp])).toEqual([row.stamp]);
      expect(await present('coupons', [row.coupon])).toEqual([row.coupon]);
    } finally {
      await pool.query(`DROP TRIGGER ${marker} ON tamaya.coupons`);
      await pool.query(`DROP FUNCTION tamaya.${marker}()`);
    }
    expect((await db.purgeDetachedRecords(f.id, f.project)).stampEvents).toBe(1);
  });

  it('works through the runtime RLS policy without superuser or bypass privileges', async () => {
    const f = await fixture(), row = await records(f, older);
    const role = 'retention_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pool.query(`GRANT tamaya_api TO ${role}`);
    const runtime = new PostgresDatabase(new Pool({ connectionString: databaseUrl, options: `-c role=${role}` }), { now: () => now });
    try {
      expect((await runtime.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(await runtime.purgeDetachedRecords(f.id, f.project)).toEqual({ stampEvents: 1, coupons: 1, auditRecords: 1, deletionJobs: 0 });
      expect(await present('audit_log', [row.audit])).toHaveLength(0);
    } finally { await runtime.close(); await pool.query(`DROP ROLE ${role}`); }
  });
});
