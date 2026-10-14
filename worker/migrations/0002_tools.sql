-- Usage from every tool ccusage reads, not only Claude Code (upload format 2).
-- Until now every row came from Claude Code.

-- The tools each machine has reported usage for, as a JSON array of ids.
ALTER TABLE machines ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';

UPDATE machines SET tools = '["claude"]'
 WHERE EXISTS (SELECT 1 FROM usage_daily WHERE usage_daily.machine_id = machines.id);

-- Every tool the dashboard has seen, in the order they first appeared. Charts
-- give tools their colors in this order, so a tool keeps its color.
INSERT INTO settings (key, value)
SELECT 'tools', CASE WHEN EXISTS (SELECT 1 FROM usage_daily) THEN '["claude"]' ELSE '[]' END;
