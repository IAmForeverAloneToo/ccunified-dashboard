-- Enrollment keys let a script add many machines without anyone typing a
-- code: a machine that enrolls with a key waits on the Approvals page (for 30
-- days) to be approved into the key's department, with the key's owner.
-- Deleting a department deletes its keys.
CREATE TABLE enrollment_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  department_id TEXT REFERENCES departments (id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  -- When it stops working, or NULL for never.
  expires_at INTEGER,
  -- How many machines may enroll with it, or NULL for any number.
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

-- The key a machine enrolled with (NULL for machines that showed a code).
ALTER TABLE pairing_requests ADD COLUMN enrollment_key_id TEXT REFERENCES enrollment_keys (id) ON DELETE SET NULL;
