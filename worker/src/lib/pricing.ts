// The dashboard's cost estimates. Each machine's ccusage reports a cost with
// its usage; admins can choose to work costs out on the dashboard instead,
// from the token counts and a price per model:
//
// - "ccusage": the costs ccusage reported (the default).
// - "lists": the model maker's price on models.dev, else on LiteLLM, else
//   ccusage's cost. Machines send these prices once a day.
// - "custom": the admins' own prices, else as "lists".
//
// Costs are worked out when shown, so a change applies to all history. The
// daily totals can't show long-context surcharges or the 1-hour cache-write
// rate, so the base prices apply.

export type PricingMode = "ccusage" | "lists" | "custom";
export type PriceSource = "custom" | "models.dev" | "litellm";

export const PRICING_MODES: PricingMode[] = ["ccusage", "lists", "custom"];

export function readPricingMode(value: string | undefined): PricingMode {
  return PRICING_MODES.includes(value as PricingMode) ? (value as PricingMode) : "ccusage";
}

/** A price in US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface PriceRow extends Price {
  model: string;
  source: PriceSource;
  entry: string | null;
}

/** The order in which sources are tried in each mode. */
const ORDER: Record<PricingMode, PriceSource[]> = {
  ccusage: [],
  lists: ["models.dev", "litellm"],
  custom: ["custom", "models.dev", "litellm"],
};

export async function priceRows(db: D1Database): Promise<PriceRow[]> {
  const { results } = await db
    .prepare(
      "SELECT model, source, input, output, cache_write, cache_read, entry FROM model_prices",
    )
    .all<PriceRow>();
  return results;
}

/**
 * The price each model gets in a mode, and where it comes from; models that
 * aren't in the map keep ccusage's cost.
 */
export async function effectivePrices(
  db: D1Database,
  mode: PricingMode,
): Promise<Map<string, PriceRow>> {
  const out = new Map<string, PriceRow>();
  const order = ORDER[mode];
  if (order.length === 0) return out;
  for (const row of await priceRows(db)) {
    const rank = order.indexOf(row.source);
    if (rank < 0) continue;
    const current = out.get(row.model);
    if (!current || rank < order.indexOf(current.source)) out.set(row.model, row);
  }
  return out;
}

/**
 * Sets the list prices of `models` (models.dev and LiteLLM) to the ones most
 * machines agree on, from what each machine reported: one machine can't
 * change a price that others report differently. A tie goes to the price
 * reported first. A list price no machine reports any more is removed. The
 * first two statements' changes count the prices that changed; the third
 * only brings the list entries up to date.
 */
export function settleListPrices(
  db: D1Database,
  models: string[],
  now = Date.now(),
): D1PreparedStatement[] {
  const list = JSON.stringify([...new Set(models)]);
  return [
    db
      .prepare(
        `WITH votes AS (
           SELECT model, source, input, output, cache_write, cache_read, MIN(entry) AS entry,
                  COUNT(*) AS machines, MIN(reported_at) AS since
             FROM model_price_reports
            WHERE model IN (SELECT value FROM json_each(?1))
            GROUP BY model, source, input, output, cache_write, cache_read
         ), ranked AS (
           SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY model, source
                    ORDER BY machines DESC, since, input, output, cache_write, cache_read
                  ) AS rank
             FROM votes
         )
         INSERT INTO model_prices (model, source, input, output, cache_write, cache_read, entry, updated_at)
         SELECT model, source, input, output, cache_write, cache_read, entry, ?2
           FROM ranked WHERE rank = 1
         ON CONFLICT (model, source) DO UPDATE SET
                input = excluded.input, output = excluded.output,
                cache_write = excluded.cache_write, cache_read = excluded.cache_read,
                entry = excluded.entry, updated_at = excluded.updated_at
          WHERE model_prices.input IS NOT excluded.input
             OR model_prices.output IS NOT excluded.output
             OR model_prices.cache_write IS NOT excluded.cache_write
             OR model_prices.cache_read IS NOT excluded.cache_read`,
      )
      .bind(list, now),
    db
      .prepare(
        `DELETE FROM model_prices
          WHERE source IN ('models.dev', 'litellm')
            AND model IN (SELECT value FROM json_each(?1))
            AND NOT EXISTS (SELECT 1 FROM model_price_reports r
                             WHERE r.model = model_prices.model AND r.source = model_prices.source)`,
      )
      .bind(list),
    // The list entry a price came from can change while the price doesn't.
    db
      .prepare(
        `UPDATE model_prices
            SET entry = (SELECT MIN(r.entry) FROM model_price_reports r
                          WHERE r.model = model_prices.model AND r.source = model_prices.source
                            AND r.input = model_prices.input AND r.output = model_prices.output
                            AND r.cache_write = model_prices.cache_write
                            AND r.cache_read = model_prices.cache_read)
          WHERE source IN ('models.dev', 'litellm')
            AND model IN (SELECT value FROM json_each(?1))
            AND entry IS NOT (SELECT MIN(r.entry) FROM model_price_reports r
                               WHERE r.model = model_prices.model AND r.source = model_prices.source
                                 AND r.input = model_prices.input AND r.output = model_prices.output
                                 AND r.cache_write = model_prices.cache_write
                                 AND r.cache_read = model_prices.cache_read)`,
      )
      .bind(list),
  ];
}

/** The cost of some tokens at a price. */
export function costAt(
  p: Price,
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
): number {
  return (
    (input * p.input + output * p.output + cacheWrite * p.cache_write + cacheRead * p.cache_read) /
    1e6
  );
}
