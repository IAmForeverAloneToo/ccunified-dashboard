import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { readJson } from "../lib/http";
import { bumpDataVersion, getSettings } from "../lib/settings";

/** A price from a list, in US dollars per million tokens. */
const ListPrice = z.strictObject({
  input: z.number().min(0).max(1e6),
  output: z.number().min(0).max(1e6),
  cache_write: z.number().min(0).max(1e6),
  cache_read: z.number().min(0).max(1e6),
  entry: z.string().max(200),
});

const Body = z.strictObject({
  prices: z
    .record(
      z.string().min(1).max(200),
      z.strictObject({ models_dev: ListPrice.optional(), litellm: ListPrice.optional() }),
    )
    .refine((p) => Object.keys(p).length <= 500, { message: "at most 500 models" }),
});

/**
 * POST /agent/prices — a machine sends the prices of the dashboard's models
 * from the public price lists (models.dev and LiteLLM), once a day; send none
 * to just ask. Answers with every model the dashboard has seen, whose prices
 * it wants. Only those models' prices are kept.
 */
export async function receivePrices(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, Body);
  const db = c.env.DB;
  const settings = await getSettings(db);
  const known = new Set(settings.models);
  const rows: object[] = [];
  for (const [model, p] of Object.entries(body.prices)) {
    if (!known.has(model)) continue;
    if (p.models_dev) rows.push({ model, source: "models.dev", ...p.models_dev });
    if (p.litellm) rows.push({ model, source: "litellm", ...p.litellm });
  }
  if (rows.length > 0) {
    const res = await db
      .prepare(
        `INSERT INTO model_prices (model, source, input, output, cache_write, cache_read, entry, updated_at)
         SELECT json_extract(value, '$.model'), json_extract(value, '$.source'),
                json_extract(value, '$.input'), json_extract(value, '$.output'),
                json_extract(value, '$.cache_write'), json_extract(value, '$.cache_read'),
                json_extract(value, '$.entry'), ?2
           FROM json_each(?1) WHERE true
         ON CONFLICT (model, source) DO UPDATE SET
                input = excluded.input, output = excluded.output,
                cache_write = excluded.cache_write, cache_read = excluded.cache_read,
                entry = excluded.entry, updated_at = excluded.updated_at
          WHERE model_prices.input IS NOT excluded.input
             OR model_prices.output IS NOT excluded.output
             OR model_prices.cache_write IS NOT excluded.cache_write
             OR model_prices.cache_read IS NOT excluded.cache_read
             OR model_prices.entry IS NOT excluded.entry`,
      )
      .bind(JSON.stringify(rows), Date.now())
      .run();
    // Costs shown from these prices change.
    if (res.meta.changes > 0 && settings.pricing !== "ccusage") await bumpDataVersion(db).run();
  }
  return c.json({ ok: true, models: settings.models });
}
