-- Trusted setup in the authenticated Supabase SQL Editor only.
-- First verify this exact Firebase user is email-confirmed and enabled in tamayaapp.
-- The owner CLI performs those checks BEFORE requesting the DB password.
-- Replace the two UID placeholders; never add Firebase keys or DB passwords here.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
DO $owner_setup$
DECLARE
  v_store_id constant text := 'tamaya';
  v_uid constant text := '__OWNER_FIREBASE_UID__';
  v_project_id text;
  v_changed_uid text;
BEGIN
  IF v_uid !~ '^[A-Za-z0-9]{28}$' THEN
    RAISE EXCEPTION 'OWNER_UID_REQUIRED';
  END IF;
  SELECT firebase_project_id INTO v_project_id
    FROM tamaya.stores WHERE id = v_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_STORE_NOT_READY'; END IF;
  IF v_project_id <> 'tamayaapp' THEN RAISE EXCEPTION 'OWNER_STORE_PROJECT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('register:' || v_project_id || ':' || v_uid, 0));
  IF EXISTS (SELECT 1 FROM tamaya.deletion_jobs
    WHERE firebase_project_id = v_project_id AND uid = v_uid AND state = 'pending') THEN
    RAISE EXCEPTION 'OWNER_ACCOUNT_DELETING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tamaya.members
    WHERE store_id = v_store_id AND uid = v_uid AND state = 'active') THEN
    RAISE EXCEPTION 'OWNER_ACTIVE_MEMBER_REQUIRED';
  END IF;
  INSERT INTO tamaya.staff AS existing_staff (store_id, uid, role, active)
    VALUES (v_store_id, v_uid, 'owner', true)
    ON CONFLICT (store_id, uid) DO UPDATE SET role = 'owner', active = true
    WHERE existing_staff.role IS DISTINCT FROM 'owner' OR existing_staff.active IS DISTINCT FROM true
    RETURNING uid INTO v_changed_uid;
  IF v_changed_uid IS NOT NULL THEN
    INSERT INTO tamaya.audit_log (id, store_id, actor_uid, action, target_id, created_at)
      VALUES (pg_catalog.gen_random_uuid(), v_store_id, 'trusted-bootstrap', 'owner.bootstrap', v_uid, clock_timestamp());
  END IF;
END
$owner_setup$;
COMMIT;
SELECT s.role, s.active
  FROM tamaya.staff s JOIN tamaya.stores t ON t.id = s.store_id
  WHERE s.store_id = 'tamaya' AND t.firebase_project_id = 'tamayaapp'
    AND s.uid = '__OWNER_FIREBASE_UID__';
