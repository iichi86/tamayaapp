import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/production/database.js';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('SQL Editor owner setup fallback (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const database = new PostgresDatabase(pool);
  let template: string;
  beforeAll(async () => {
    await database.migrate();
    template = await readFile(new URL('../supabase/bootstrap_owner.sql', import.meta.url), 'utf8');
  });
  afterAll(async () => { await database.close(); });

  async function fixture() {
    const storeId = 'sql-' + randomUUID().slice(0, 12);
    const uid = randomUUID().replaceAll('-', '').slice(0, 28);
    await pool.query('INSERT INTO tamaya.stores(id,firebase_project_id,info) VALUES($1,$2,$3)', [storeId, 'tamayaapp', { id: storeId }]);
    const memberId = randomUUID();
    await pool.query("INSERT INTO tamaya.members(id,store_id,uid,number,nickname,terms_version,privacy_version) VALUES($1,$2,$3,'9999999999','SQL fixture','test','test')", [memberId, storeId, uid]);
    return { storeId, uid, memberId };
  }
  function rendered(storeId: string, uid: string): string {
    return template.replaceAll("'tamaya'", `'${storeId}'`).replaceAll('__OWNER_FIREBASE_UID__', uid);
  }
  async function run(storeId: string, uid: string) {
    const client = await pool.connect();
    try { return await client.query(rendered(storeId, uid)); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  it('sets one active owner and records an audit once across repeated execution', async () => {
    const f = await fixture();
    await run(f.storeId, f.uid); await run(f.storeId, f.uid);
    expect((await pool.query('SELECT role,active FROM tamaya.staff WHERE store_id=$1 AND uid=$2', [f.storeId, f.uid])).rows).toEqual([{ role: 'owner', active: true }]);
    expect((await pool.query("SELECT actor_uid,action,target_id FROM tamaya.audit_log WHERE store_id=$1", [f.storeId])).rows).toEqual([{ actor_uid: 'trusted-bootstrap', action: 'owner.bootstrap', target_id: f.uid }]);
    expect((await pool.query('SELECT stamps,state FROM tamaya.members WHERE id=$1', [f.memberId])).rows[0]).toEqual({ stamps: 0, state: 'active' });
  });

  it('requires the expected store project and leaves permissions unchanged on failure', async () => {
    const f = await fixture();
    await pool.query("UPDATE tamaya.stores SET firebase_project_id='different-project' WHERE id=$1", [f.storeId]);
    await expect(run(f.storeId, f.uid)).rejects.toThrow('OWNER_STORE_PROJECT');
    expect((await pool.query('SELECT 1 FROM tamaya.staff WHERE store_id=$1', [f.storeId])).rowCount).toBe(0);
  });

  it('fails clearly for a missing store or unfinished member registration', async () => {
    const f = await fixture();
    await expect(run('missing-' + randomUUID(), f.uid)).rejects.toThrow('OWNER_STORE_NOT_READY');
    await expect(run(f.storeId, 'B'.repeat(28))).rejects.toThrow('OWNER_ACTIVE_MEMBER_REQUIRED');
    expect((await pool.query('SELECT 1 FROM tamaya.staff WHERE store_id=$1', [f.storeId])).rowCount).toBe(0);
  });

  it('rejects pending deletion and a non-active member', async () => {
    const f = await fixture();
    const deletion = randomUUID();
    await pool.query('INSERT INTO tamaya.deletion_jobs(id,firebase_project_id,uid) VALUES($1,$2,$3)', [deletion, 'tamayaapp', f.uid]);
    await expect(run(f.storeId, f.uid)).rejects.toThrow('OWNER_ACCOUNT_DELETING');
    await pool.query('DELETE FROM tamaya.deletion_jobs WHERE id=$1', [deletion]);
    await pool.query("UPDATE tamaya.members SET state='deletion_pending' WHERE id=$1", [f.memberId]);
    await expect(run(f.storeId, f.uid)).rejects.toThrow('OWNER_ACTIVE_MEMBER_REQUIRED');
  });

  it('leaves another staff account, store data and RLS settings untouched', async () => {
    const f = await fixture();
    await pool.query("INSERT INTO tamaya.staff(store_id,uid,role,active) VALUES($1,'other-fixture','staff',true)", [f.storeId]);
    const flags = (await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='tamaya'::regnamespace AND relkind='r' ORDER BY relname")).rows;
    const info = (await pool.query('SELECT info FROM tamaya.stores WHERE id=$1', [f.storeId])).rows[0].info;
    await run(f.storeId, f.uid);
    expect((await pool.query("SELECT role,active FROM tamaya.staff WHERE store_id=$1 AND uid='other-fixture'", [f.storeId])).rows).toEqual([{ role: 'staff', active: true }]);
    expect((await pool.query('SELECT info FROM tamaya.stores WHERE id=$1', [f.storeId])).rows[0].info).toEqual(info);
    expect((await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='tamaya'::regnamespace AND relkind='r' ORDER BY relname")).rows).toEqual(flags);
    expect(flags.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('rejects an unchanged placeholder instead of writing a bogus owner', async () => {
    const f = await fixture();
    await expect(run(f.storeId, '__OWNER_FIREBASE_UID__')).rejects.toThrow('OWNER_UID_REQUIRED');
    expect((await pool.query('SELECT 1 FROM tamaya.staff WHERE store_id=$1', [f.storeId])).rowCount).toBe(0);
  });

  it('works through the existing server policy without superuser or RLS bypass', async () => {
    const f = await fixture();
    const role = 'sql_setup_' + randomUUID().replaceAll('-', '');
    const client = await pool.connect();
    try {
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT tamaya_api TO ${role}`);
      await client.query(`SET ROLE ${role}`);
      await client.query(rendered(f.storeId, f.uid));
      expect((await client.query('SELECT role,active FROM tamaya.staff WHERE store_id=$1 AND uid=$2', [f.storeId, f.uid])).rows).toEqual([{ role: 'owner', active: true }]);
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      await client.query(`DROP ROLE IF EXISTS ${role}`);
      client.release();
    }
  });
});
