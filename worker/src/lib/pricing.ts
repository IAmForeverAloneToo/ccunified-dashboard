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
