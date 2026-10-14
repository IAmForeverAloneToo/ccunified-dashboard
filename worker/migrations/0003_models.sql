-- Every model the dashboard has seen, in the order they first appeared. The
-- chart names each model's family and gives families their colors in this
-- order, so a family keeps its color.
INSERT INTO settings (key, value)
SELECT 'models', COALESCE(
  (SELECT json_group_array(model)
     FROM (SELECT model FROM usage_daily GROUP BY model ORDER BY MIN(day), model)),
  '[]');
