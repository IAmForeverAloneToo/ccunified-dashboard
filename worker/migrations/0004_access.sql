-- Access control: departments, people's roles in them, and each machine's
-- department and owner.
--
-- A user's dashboard-wide role stays 'admin' or 'viewer', but may now be
-- empty for people who only have roles in some departments. SQLite can't
-- change a column's constraints, so the users table is rebuilt. Dropping it
-- would delete the rows that refer to it (sessions, two-factor recovery
-- codes) and forget who decided pairing requests, so those are set aside
-- first and put back after.
CREATE TABLE keep_sessions AS SELECT * FROM sessions;
CREATE TABLE keep_recovery_codes AS SELECT * FROM recovery_codes;
CREATE TABLE keep_decided_by AS
  SELECT id, decided_by FROM pairing_requests WHERE decided_by IS NOT NULL;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  -- Dashboard-wide: 'admin', 'viewer', or none (only department roles).
  role TEXT CHECK (role IN ('admin', 'viewer')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
) STRICT;

INSERT INTO users_new (id, username, password_hash, role, totp_secret, totp_enabled,
                       totp_last_step, must_change_password, created_at,
                       password_changed_at, last_login_at, disabled_at)
SELECT id, username, password_hash, role, totp_secret, totp_enabled, totp_last_step,
       must_change_password, created_at, password_changed_at, last_login_at, disabled_at
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

INSERT INTO sessions SELECT * FROM keep_sessions;
INSERT INTO recovery_codes SELECT * FROM keep_recovery_codes;
UPDATE pairing_requests
   SET decided_by = (SELECT k.decided_by FROM keep_decided_by k WHERE k.id = pairing_requests.id)
 WHERE id IN (SELECT id FROM keep_decided_by);
DROP TABLE keep_sessions;
DROP TABLE keep_recovery_codes;
DROP TABLE keep_decided_by;

-- Departments are flat: no department inside another.
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
) STRICT;

-- A person's role in a department: 'manager' (sees and manages its machines
-- and plain users), 'viewer' (sees its machines) or 'member' (can own its
-- machines, and sees the ones they own).
CREATE TABLE department_roles (
  department_id TEXT NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager', 'viewer', 'member')),
  PRIMARY KEY (department_id, user_id)
) STRICT;

CREATE INDEX department_roles_by_user ON department_roles (user_id);

-- A machine belongs to at most one department and has at most one owner;
-- without an owner it is shared. Existing machines start with neither.
ALTER TABLE machines ADD COLUMN department_id TEXT REFERENCES departments (id) ON DELETE SET NULL;
ALTER TABLE machines ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX machines_by_department ON machines (department_id);
CREATE INDEX machines_by_owner ON machines (owner_id);

-- Picked when a machine is approved, and given to it when it joins.
ALTER TABLE pairing_requests ADD COLUMN department_id TEXT REFERENCES departments (id) ON DELETE SET NULL;
ALTER TABLE pairing_requests ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
