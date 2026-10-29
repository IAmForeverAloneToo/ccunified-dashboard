-- Indexes for counting the machines waiting to join (all of them, and per
-- enrollment key) and for finding the names in use that start with a name.
CREATE INDEX pairing_by_status ON pairing_requests (status, expires_at, enrollment_key_id);
CREATE INDEX pairing_by_key ON pairing_requests (enrollment_key_id, status);
CREATE INDEX pairing_by_name ON pairing_requests (machine_name COLLATE NOCASE);
CREATE INDEX machines_by_name ON machines (name COLLATE NOCASE);

-- Machines that enrolled with a key of a department that was deleted lost
-- their key, and looked like machines showing a code that nobody can see:
-- deny them (deleting a department now does so itself). Only enrolled
-- machines wait longer than a code's 10 minutes.
UPDATE pairing_requests
   SET status = 'denied', decided_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
 WHERE status = 'pending' AND enrollment_key_id IS NULL AND expires_at - created_at > 600000;
