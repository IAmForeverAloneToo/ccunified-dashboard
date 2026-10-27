-- Revoked machines that were removed from the dashboard but whose usage was
-- kept: they no longer show on the Machines page, and their usage counts as
-- "Removed machines". (Removing a machine with its usage deletes the row.)
ALTER TABLE machines ADD COLUMN removed_at INTEGER;
