import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { PRICING_MODES, type PriceRow, priceRows } from "../lib/pricing";
import { bumpDataVersion, getSettings, setSetting } from "../lib/settings";

const strip = ({ model: _m, source: _s, ...p }: PriceRow) => p;

/**
 * GET /api/prices (admins and viewers) — how costs are worked out, and every
 * model's prices: custom, from models.dev and from LiteLLM (null where there
 * is none).
 */
export async function listPrices(c: Context<AppEnv>): Promise<Response> {
  const [settings, rows] = await Promise.all([getSettings(c.env.DB), priceRows(c.env.DB)]);
  const models = [...new Set([...settings.models, ...rows.map((r) => r.model)])];
  const find = (model: string, source: PriceRow["source"]) => {
    const row = rows.find((r) => r.model === model && r.source === source);
    return row ? strip(row) : null;
  };
  return c.json({
    mode: settings.pricing,
    models: models.map((model) => ({
      model,
      custom: find(model, "custom"),
      models_dev: find(model, "models.dev"),
      litellm: find(model, "litellm"),
    })),
  });
}

const CustomPrice = z.strictObject({
  input: z.number().min(0).max(1e6),
  output: z.number().min(0).max(1e6),
  cache_write: z.number().min(0).max(1e6),
  cache_read: z.number().min(0).max(1e6),
});

const Change = z
  .strictObject({
    mode: z.enum(PRICING_MODES as [string, ...string[]]).optional(),
    /** Custom prices by model; null removes one. */
    custom: z
      .record(z.string().min(1).max(200), CustomPrice.nullable())
      .refine((p) => Object.keys(p).length <= 500, { message: "at most 500 models" })
      .optional(),
  })
  .refine((b) => b.mode !== undefined || b.custom !== undefined, { message: "nothing to change" });

/**
 * PATCH /api/prices (admin) — `{ mode?, custom? }`: choose how costs are
 * worked out, and set or remove custom prices (US dollars per million tokens).
 */
export async function updatePrices(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, Change);
  const db = c.env.DB;
  const writes: D1PreparedStatement[] = [];
  if (body.mode) writes.push(setSetting(db, "pricing", body.mode));
  const now = Date.now();
  for (const [model, p] of Object.entries(body.custom ?? {})) {
    writes.push(
      p === null
        ? db.prepare("DELETE FROM model_prices WHERE model = ?1 AND source = 'custom'").bind(model)
        : db
            .prepare(
              `INSERT INTO model_prices (model, source, input, output, cache_write, cache_read, entry, updated_at)
               VALUES (?1, 'custom', ?2, ?3, ?4, ?5, NULL, ?6)
               ON CONFLICT (model, source) DO UPDATE SET
                 input = excluded.input, output = excluded.output, cache_write = excluded.cache_write,
                 cache_read = excluded.cache_read, updated_at = excluded.updated_at`,
            )
            .bind(model, p.input, p.output, p.cache_write, p.cache_read, now),
    );
  }
  if (writes.length === 0) fail(400, "invalid_request");
  // Costs are worked out anew.
  writes.push(bumpDataVersion(db));
  await db.batch(writes);
  return c.json({ ok: true });
}
