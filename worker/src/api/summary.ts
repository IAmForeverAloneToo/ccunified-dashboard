import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail } from "../lib/http";
import { getSettings } from "../lib/settings";
import { addDays, daysBetween, todayIn } from "../lib/time";

const MAX_SPAN_DAYS = 3660;

const Query = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

interface Totals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

interface Row extends Totals {
  day: string;
  machine_id: string;
  model: string;
}

function emptyTotals(): Totals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
  };
}

function add(into: Totals, row: Totals): void {
  into.input_tokens += row.input_tokens;
  into.output_tokens += row.output_tokens;
  into.cache_creation_tokens += row.cache_creation_tokens;
  into.cache_read_tokens += row.cache_read_tokens;
  into.cost_usd += row.cost_usd;
}

/**
 * GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD — usage per day, split by
 * machine and (separately) by model. Defaults to the last 30 days.
 *
 * Responds 304 when the dashboard already has the current data (ETag), which
 * keeps D1 reads tiny while a dashboard polls.
 */
export async function summary(c: Context<AppEnv>): Promise<Response> {
  const query = Query.safeParse(c.req.query());
  if (!query.success) fail(400, "invalid_request", { message: "from/to must be YYYY-MM-DD" });

  const settings = await getSettings(c.env.DB);
  const today = todayIn(settings.timezone);
  const to = query.data.to ?? today;
  const from = query.data.from ?? addDays(to, -29);
  if (from > to) fail(400, "invalid_request", { message: "from must not be after to" });
  if (daysBetween(from, to) > MAX_SPAN_DAYS) {
    fail(400, "invalid_request", { message: `at most ${MAX_SPAN_DAYS} days` });
  }

  const etag = `W/"${settings.dataVersion}:${settings.timezone}:${today}:${from}:${to}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT day, machine_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens, SUM(cost_usd) AS cost_usd
       FROM usage_daily
      WHERE day BETWEEN ?1 AND ?2
      GROUP BY day, machine_id, model
      ORDER BY day`,
  )
    .bind(from, to)
    .all<Row>();

  const byMachine = new Map<string, Totals & { day: string; machine_id: string }>();
  const byModel = new Map<string, Totals & { day: string; model: string }>();
  for (const r of results) {
    const mk = `${r.day}|${r.machine_id}`;
    const m = byMachine.get(mk) ?? { day: r.day, machine_id: r.machine_id, ...emptyTotals() };
    add(m, r);
    byMachine.set(mk, m);
    const dk = `${r.day}|${r.model}`;
    const d = byModel.get(dk) ?? { day: r.day, model: r.model, ...emptyTotals() };
    add(d, r);
    byModel.set(dk, d);
  }

  return c.json(
    {
      timezone: settings.timezone,
      today,
      from,
      to,
      by_day_machine: [...byMachine.values()],
      by_day_model: [...byModel.values()],
    },
    200,
    { etag },
  );
}
