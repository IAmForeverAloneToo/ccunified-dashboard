import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { readJson } from "../lib/http";
import { settleListPrices } from "../lib/pricing";
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

/** Room for 500 models with prices from both lists (about 260 bytes per list price). */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * POST /agent/prices — a machine sends the prices of the dashboard's models
 * from the public price lists (models.dev and LiteLLM), once a day; send none
 * to just ask. Answers with every model the dashboard has seen, whose prices
 * it wants. Only those models' prices are kept.
 *
 * Each machine's prices are kept as its own report, and the dashboard uses
 * the price most machines agree on (see settleListPrices): one machine can't
 * set the prices everyone sees. A machine's report stays until it sends
 * another price for that model and list, or it's revoked.
 */
export async function receivePrices(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, Body, MAX_BODY_BYTES);
  const machine = c.get("machine");
  const db = c.env.DB;
  const settings = await getSettings(db);
  const known = new Set(settings.models);
  const rows: object[] = [];
  for (const [model, p] of Object.entries(body.prices)) {
    if (!known.has(model)) continue;
    if (p.models_dev) rows.push({ model, source: "models.dev", ...p.models_dev });
    if (p.litellm) rows.push({ model, source: "litellm", ...p.litellm });
  }
  if (rows.length === 0) return c.json({ ok: true, models: settings.models });

  // Answers the models whose report from this machine is new or changed.
  const now = Date.now();
  const { results: changed } = await db
    .prepare(
      `INSERT INTO model_price_reports (model, source, machine_id, input, output, cache_write,
                                        cache_read, entry, reported_at)
       SELECT json_extract(value, '$.model'), json_extract(value, '$.source'), ?1,
              json_extract(value, '$.input'), json_extract(value, '$.output'),
              json_extract(value, '$.cache_write'), json_extract(value, '$.cache_read'),
              json_extract(value, '$.entry'), ?2
         FROM json_each(?3) WHERE true
       ON CONFLICT (model, source, machine_id) DO UPDATE SET
              reported_at = CASE
                WHEN model_price_reports.input IS excluded.input
                 AND model_price_reports.output IS excluded.output
                 AND model_price_reports.cache_write IS excluded.cache_write
                 AND model_price_reports.cache_read IS excluded.cache_read
                THEN model_price_reports.reported_at ELSE excluded.reported_at END,
              input = excluded.input, output = excluded.output,
              cache_write = excluded.cache_write, cache_read = excluded.cache_read,
              entry = excluded.entry
        WHERE model_price_reports.input IS NOT excluded.input
           OR model_price_reports.output IS NOT excluded.output
           OR model_price_reports.cache_write IS NOT excluded.cache_write
           OR model_price_reports.cache_read IS NOT excluded.cache_read
           OR model_price_reports.entry IS NOT excluded.entry
       RETURNING model`,
    )
    .bind(machine.id, now, JSON.stringify(rows))
    .all<{ model: string }>();
  if (changed.length > 0) {
    const [upserted, removed] = await db.batch(
      settleListPrices(
        db,
        changed.map((r) => r.model),
        now,
      ),
    );
    // Costs shown from these prices change.
    const prices = (upserted?.meta.changes ?? 0) + (removed?.meta.changes ?? 0);
    if (prices > 0 && settings.pricing !== "ccusage") await bumpDataVersion(db).run();
  }
  return c.json({ ok: true, models: settings.models });
}
