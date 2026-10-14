-- Initial schema. Times are Unix milliseconds unless noted.
-- Statements are separated by a semicolon at the end of a line; keep each
-- statement free of inner semicolons so both the Worker test harness and the
-- ccunified setup wizard can split this file the same way.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO settings (key, value) VALUES
  ('timezone', 'UTC'),
  ('data_version', '0');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step INTEGER,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
) STRICT;

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
) STRICT;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_by_user ON sessions (user_id);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL
) STRICT;

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  ccusage_version TEXT,
  sync_interval_minutes INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  sync_interval_minutes INTEGER NOT NULL,
  client_ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'claimed')),
  decided_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at INTEGER,
  machine_id TEXT REFERENCES machines (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX pairing_by_user_code ON pairing_requests (user_code);

CREATE TABLE usage_daily (
  machine_id TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, source, day, model)
) STRICT;

CREATE INDEX usage_by_day ON usage_daily (day);
