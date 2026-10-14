import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { fail } from "../lib/http";
import { getSettings } from "../lib/settings";
import { addDays, daysBetween, todayIn } from "../lib/time";

const MAX_SPAN_DAYS = 3660;

const Query = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Last N days ending today (in the dashboard's time zone); ignored if `from` is given. */
  days: z.coerce.number().int().min(1).max(MAX_SPAN_DAYS).optional(),
  /** detail=1 adds every row (day, machine, tool, model), for filtering in the browser. */
  detail: z.literal("1").optional(),
});

/** A row of `detail`: [day, machine, tool, model, input, output, cache write, cache read, cost]. */
type DetailRow = [string, number, number, number, number, number, number, number, number];

/** Gives each distinct value a small number, so repeated ids aren't repeated in the answer. */
function indexer() {
  const list: string[] = [];
  const at = new Map<string, number>();
  return {
    list,
    of(value: string): number {
      let i = at.get(value);
      if (i === undefined) {
        i = list.length;
        list.push(value);
        at.set(value, i);
      }
      return i;
    },
  };
}

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
  source: string;
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
 * GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?days=N) — usage per
 * day, split by machine, by model and by tool, and each machine's usage per
 * tool for the whole period. Defaults to the last 30 days.
 *
 * Responds 304 when the dashboard already has the current data (ETag), which
 * keeps D1 reads tiny while a dashboard polls.
 */
export async function summary(c: Context<AppEnv>): Promise<Response> {
  const query = Query.safeParse(c.req.query());
  if (!query.success) {
    fail(400, "invalid_request", { message: "from/to must be YYYY-MM-DD; days 1-3660" });
  }

  const settings = await getSettings(c.env.DB);
  const today = todayIn(settings.timezone);
  const to = query.data.to ?? today;
  const from = query.data.from ?? addDays(to, -((query.data.days ?? 30) - 1));
  if (from > to) fail(400, "invalid_request", { message: "from must not be after to" });
  if (daysBetween(from, to) > MAX_SPAN_DAYS) {
    fail(400, "invalid_request", { message: `at most ${MAX_SPAN_DAYS} days` });
  }

  const detail = query.data.detail === "1";
  const etag = `W/"${settings.dataVersion}:${settings.timezone}:${today}:${from}:${to}${detail ? ":detail" : ""}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT day, machine_id, source, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens, SUM(cost_usd) AS cost_usd
       FROM usage_daily
      WHERE day BETWEEN ?1 AND ?2
      GROUP BY day, machine_id, source, model
      ORDER BY day`,
  )
    .bind(from, to)
    .all<Row>();

  const byMachine = new Map<string, Totals & { day: string; machine_id: string }>();
  const byModel = new Map<string, Totals & { day: string; model: string }>();
  const bySource = new Map<string, Totals & { day: string; source: string }>();
  const machineSource = new Map<string, Totals & { machine_id: string; source: string }>();
  for (const r of results) {
    const mk = `${r.day}|${r.machine_id}`;
    const m = byMachine.get(mk) ?? { day: r.day, machine_id: r.machine_id, ...emptyTotals() };
    add(m, r);
    byMachine.set(mk, m);
    const dk = `${r.day}|${r.model}`;
    const d = byModel.get(dk) ?? { day: r.day, model: r.model, ...emptyTotals() };
    add(d, r);
    byModel.set(dk, d);
    const sk = `${r.day}|${r.source}`;
    const t = bySource.get(sk) ?? { day: r.day, source: r.source, ...emptyTotals() };
    add(t, r);
    bySource.set(sk, t);
    const ms = `${r.machine_id}|${r.source}`;
    const u = machineSource.get(ms) ?? {
      machine_id: r.machine_id,
      source: r.source,
      ...emptyTotals(),
    };
    add(u, r);
    machineSource.set(ms, u);
  }

  let detailBody: object | undefined;
  if (detail) {
    const machinesIx = indexer();
    const sourcesIx = indexer();
    const modelsIx = indexer();
    const rows: DetailRow[] = results.map((r) => [
      r.day,
      machinesIx.of(r.machine_id),
      sourcesIx.of(r.source),
      modelsIx.of(r.model),
      r.input_tokens,
      r.output_tokens,
      r.cache_creation_tokens,
      r.cache_read_tokens,
      r.cost_usd,
    ]);
    detailBody = {
      machines: machinesIx.list,
      sources: sourcesIx.list,
      models: modelsIx.list,
      rows,
    };
  }

  return c.json(
    {
      timezone: settings.timezone,
      today,
      from,
      to,
      /** Every tool the dashboard has seen, in the order they first appeared. */
      tools: settings.tools,
      /** Every model the dashboard has seen, in the order they first appeared. */
      models: settings.models,
      by_day_machine: [...byMachine.values()],
      by_day_model: [...byModel.values()],
      by_day_source: [...bySource.values()],
      by_machine_source: [...machineSource.values()],
      ...(detailBody ? { detail: detailBody } : {}),
    },
    200,
    { etag },
  );
}

const DaysQuery = z.object({ from: z.iso.date(), to: z.iso.date() });

/** Repeated filter parameters: at most 500 values of at most 200 characters each. */
const FilterList = z.array(z.string().min(1).max(200)).max(500);

/**
 * GET /api/usage-days?from=YYYY-MM-DD&to=YYYY-MM-DD — the days in the range
 * that have any usage, for marking them in the date picker. Repeated
 * `machine`, `source` and `model` parameters limit it to those machines,
 * tools and models, like the Overview's filters. Cached like the summary.
 */
export async function usageDays(c: Context<AppEnv>): Promise<Response> {
  const query = DaysQuery.safeParse(c.req.query());
  if (!query.success) fail(400, "invalid_request", { message: "from and to must be YYYY-MM-DD" });
  const { from, to } = query.data;
  if (from > to) fail(400, "invalid_request", { message: "from must not be after to" });
  if (daysBetween(from, to) > MAX_SPAN_DAYS) {
    fail(400, "invalid_request", { message: `at most ${MAX_SPAN_DAYS} days` });
  }
  const filters = z
    .object({ machine: FilterList, source: FilterList, model: FilterList })
    .safeParse({
      machine: c.req.queries("machine") ?? [],
      source: c.req.queries("source") ?? [],
      model: c.req.queries("model") ?? [],
    });
  if (!filters.success) fail(400, "invalid_request", { message: "too many or too long filters" });
  const list = (values: string[]) => (values.length > 0 ? JSON.stringify(values) : null);
  const machines = list(filters.data.machine);
  const sources = list(filters.data.source);
  const models = list(filters.data.model);

  const settings = await getSettings(c.env.DB);
  const filterKey = await sha256Hex(JSON.stringify([machines, sources, models]));
  const etag = `W/"days:${settings.dataVersion}:${settings.timezone}:${from}:${to}:${filterKey.slice(0, 16)}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT day
       FROM usage_daily
      WHERE day BETWEEN ?1 AND ?2
        AND input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens > 0
        AND (?3 IS NULL OR machine_id IN (SELECT value FROM json_each(?3)))
        AND (?4 IS NULL OR source IN (SELECT value FROM json_each(?4)))
        AND (?5 IS NULL OR model IN (SELECT value FROM json_each(?5)))
      ORDER BY day`,
  )
    .bind(from, to, machines, sources, models)
    .all<{ day: string }>();
  return c.json({ days: results.map((r) => r.day) }, 200, { etag });
}
