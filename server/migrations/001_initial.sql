CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  firebase_project_id TEXT NOT NULL,
  stamps_required INTEGER NOT NULL CHECK (stamps_required BETWEEN 1 AND 1000),
  discount_yen INTEGER NOT NULL CHECK (discount_yen BETWEEN 1 AND 1000000),
  validity_days INTEGER NOT NULL CHECK (validity_days BETWEEN 1 AND 3650),
  trial_rules INTEGER NOT NULL DEFAULT 1 CHECK (trial_rules IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  store_id TEXT NOT NULL REFERENCES stores(id),
  uid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, uid)
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  uid TEXT NOT NULL,
  number TEXT NOT NULL,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 20),
  stamps INTEGER NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (store_id, uid),
  UNIQUE (store_id, number),
  UNIQUE (store_id, id)
);

CREATE TABLE IF NOT EXISTS stamp_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  japan_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('visit', 'sample')),
  FOREIGN KEY (store_id, member_id) REFERENCES members(store_id, id),
  UNIQUE (store_id, member_id, japan_date)
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  discount_yen INTEGER NOT NULL CHECK (discount_yen > 0),
  stamps_required INTEGER NOT NULL CHECK (stamps_required > 0),
  validity_days INTEGER NOT NULL CHECK (validity_days > 0),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  FOREIGN KEY (store_id, member_id) REFERENCES members(store_id, id),
  CHECK ((used_at IS NULL AND used_by IS NULL) OR (used_at IS NOT NULL AND used_by IS NOT NULL)),
  CHECK (expires_at > issued_at)
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  store_id TEXT NOT NULL REFERENCES stores(id),
  actor_uid TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (store_id, actor_uid, request_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  actor_uid TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  japan_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS members_store_created ON members(store_id, created_at);
CREATE INDEX IF NOT EXISTS stamp_events_member_created ON stamp_events(store_id, member_id, created_at);
CREATE INDEX IF NOT EXISTS coupons_member_issued ON coupons(store_id, member_id, issued_at);
CREATE INDEX IF NOT EXISTS audit_store_created ON audit_log(store_id, created_at);
