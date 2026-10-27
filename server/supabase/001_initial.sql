-- Run once using the database owner, never from Expo or a public API.
-- Firebase Authentication identifies users; Supabase Auth is deliberately unused.
BEGIN;
CREATE SCHEMA IF NOT EXISTS tamaya;
REVOKE ALL ON SCHEMA tamaya FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tamaya_api') THEN
    CREATE ROLE tamaya_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tamaya.schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS tamaya.stores (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  firebase_project_id text NOT NULL CHECK (length(firebase_project_id) BETWEEN 1 AND 128),
  info jsonb NOT NULL CHECK (jsonb_typeof(info) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS tamaya.staff (
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('owner','staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(store_id, uid)
);
CREATE TABLE IF NOT EXISTS tamaya.members (
  id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 128),
  number text NOT NULL CHECK (number ~ '^[0-9]{10}$'),
  nickname text NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  stamps integer NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deletion_pending')),
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(store_id, uid), UNIQUE(store_id, number), UNIQUE(store_id, id)
);
CREATE TABLE IF NOT EXISTS tamaya.stamp_events (
  id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  member_id uuid,
  japan_date date NOT NULL,
  created_at timestamptz NOT NULL,
  purchase_amount_yen integer NOT NULL DEFAULT 0 CHECK (purchase_amount_yen BETWEEN 0 AND 100000000),
  UNIQUE(store_id, member_id, japan_date),
  FOREIGN KEY(store_id, member_id) REFERENCES tamaya.members(store_id, id) ON DELETE SET NULL (member_id)
);
CREATE INDEX IF NOT EXISTS stamp_events_store_day ON tamaya.stamp_events(store_id, japan_date);
CREATE TABLE IF NOT EXISTS tamaya.coupons (
  id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  member_id uuid,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  used_at timestamptz,
  policy_version text NOT NULL,
  benefit jsonb NOT NULL CHECK (jsonb_typeof(benefit) = 'object'),
  eligible_products jsonb NOT NULL CHECK (jsonb_typeof(eligible_products) = 'array'),
  combination_rule text NOT NULL,
  redemption_minimum_purchase_yen integer NOT NULL DEFAULT 0 CHECK (redemption_minimum_purchase_yen BETWEEN 0 AND 100000000),
  used_purchase_amount_yen integer CHECK (used_purchase_amount_yen BETWEEN 0 AND 100000000),
  FOREIGN KEY(store_id, member_id) REFERENCES tamaya.members(store_id, id) ON DELETE SET NULL (member_id)
);
CREATE INDEX IF NOT EXISTS coupons_store_member ON tamaya.coupons(store_id, member_id);
CREATE TABLE IF NOT EXISTS tamaya.notices (
  id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS tamaya.audit_log (
  id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  actor_uid text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  member_id uuid REFERENCES tamaya.members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);
ALTER TABLE tamaya.stamp_events ADD COLUMN IF NOT EXISTS purchase_amount_yen integer NOT NULL DEFAULT 0 CHECK (purchase_amount_yen BETWEEN 0 AND 100000000);
ALTER TABLE tamaya.coupons ADD COLUMN IF NOT EXISTS redemption_minimum_purchase_yen integer NOT NULL DEFAULT 0 CHECK (redemption_minimum_purchase_yen BETWEEN 0 AND 100000000);
ALTER TABLE tamaya.coupons ADD COLUMN IF NOT EXISTS used_purchase_amount_yen integer CHECK (used_purchase_amount_yen BETWEEN 0 AND 100000000);
ALTER TABLE tamaya.audit_log ADD COLUMN IF NOT EXISTS purchase_amount_yen integer CHECK (purchase_amount_yen BETWEEN 0 AND 100000000);
CREATE TABLE IF NOT EXISTS tamaya.idempotency (
  store_id text NOT NULL REFERENCES tamaya.stores(id),
  actor_uid text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 256),
  member_id uuid REFERENCES tamaya.members(id) ON DELETE CASCADE,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(store_id, actor_uid, key)
);
CREATE TABLE IF NOT EXISTS tamaya.deletion_jobs (
  id uuid PRIMARY KEY,
  firebase_project_id text NOT NULL,
  uid text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state = 'pending' AND uid IS NOT NULL) OR (state = 'completed' AND uid IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_deletion ON tamaya.deletion_jobs(firebase_project_id, uid) WHERE state='pending';

-- The private schema is not included in Supabase Data API exposed schemas.
-- Even if exposed by mistake, anonymous/end-user roles receive no grants or policy.
DO $$ DECLARE t text; r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA tamaya FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA tamaya FROM %I', r);
    END IF;
  END LOOP;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='tamaya' LOOP
    EXECUTE format('ALTER TABLE tamaya.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE tamaya.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS server_access ON tamaya.%I',t);
    EXECUTE format('CREATE POLICY server_access ON tamaya.%I TO tamaya_api USING (true) WITH CHECK (true)',t);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA tamaya TO tamaya_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tamaya TO tamaya_api;
-- The migration owner also needs the server policy when it is not a superuser
-- (managed PostgreSQL owners can be subject to FORCE ROW LEVEL SECURITY).
GRANT tamaya_api TO CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA tamaya FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA tamaya REVOKE ALL ON TABLES FROM PUBLIC;
INSERT INTO tamaya.schema_migrations(version) VALUES(1),(2) ON CONFLICT DO NOTHING;
COMMIT;
