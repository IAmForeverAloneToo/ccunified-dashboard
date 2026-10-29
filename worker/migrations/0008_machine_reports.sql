-- What one machine reports no longer changes the whole dashboard on its own.
--
-- List prices: each machine's report is kept separately, and the price most
-- machines agree on becomes the one in model_prices (see lib/pricing.ts).
-- The prices already there stay in use until a machine reports that model
-- again. Reports go with their machine.
CREATE TABLE model_price_reports (
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('models.dev', 'litellm')),
  machine_id TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  input REAL NOT NULL,
  output REAL NOT NULL,
  cache_write REAL NOT NULL,
  cache_read REAL NOT NULL,
  entry TEXT,
  -- When the machine first reported this price (a different price starts again).
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (model, source, machine_id)
) STRICT;

CREATE INDEX model_price_reports_by_machine ON model_price_reports (machine_id);

-- The newest release: only the dashboard's own check on GitHub sets it now,
-- not the versions machines report. Forget what machines taught it, so the
-- next request checks again.
DELETE FROM settings WHERE key IN ('latest_version', 'latest_checked_at');
