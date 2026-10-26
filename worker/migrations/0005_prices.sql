-- Prices for the dashboard's own cost estimates, in US dollars per million
-- tokens: from the public price lists ('models.dev', 'litellm'; machines send
-- the prices of the dashboard's models once a day) and set by admins
-- ('custom').
CREATE TABLE model_prices (
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('custom', 'models.dev', 'litellm')),
  input REAL NOT NULL,
  output REAL NOT NULL,
  cache_write REAL NOT NULL,
  cache_read REAL NOT NULL,
  -- The list entry it came from, such as anthropic/claude-opus-5-5.
  entry TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model, source)
) STRICT;

-- How costs are worked out: 'ccusage' (as each machine's ccusage reported
-- them), 'lists' (models.dev, then LiteLLM, then ccusage) or 'custom'
-- (custom prices, then the lists, then ccusage).
INSERT INTO settings (key, value) VALUES ('pricing', 'ccusage');
