import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { fail } from "../lib/http";
import { getSettings } from "../lib/settings";
import { addDays, type Bucket, bucketFor, daysBetween, todayIn } from "../lib/time";

const MAX_SPAN_DAYS = 3660;

const Query = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Last N days ending today (in the dashboard's time zone); ignored if `from` is given. */
  days: z.coerce.number().int().min(1).max(MAX_SPAN_DAYS).optional(),
  /** all=1: from the first day with usage (at most 3660 days back); ignores `from` and `days`. */
  all: z.literal("1").optional(),
  /** detail=1: every row (day, machine, tool, model), for filtering in the browser. */
  detail: z.literal("1").optional(),
});

/** Each bucket's first day, in SQL: the day itself, its week's Monday, or the 1st of its month. */
const BUCKET_START: Record<Bucket, string> = {
  day: "day",
  week: "date(day, '-6 days', 'weekday 1')",
  month: "date(day, 'start of month')",
};

/** [day, machine, tool, model, input, output, cache write, cache read, cost] */
type UsageRow = [string, string, string, string, number, number, number, number, number];

/** A row of `detail`: the same, with the day, machine, tool and model as positions in its lists. */
type DetailRow = [number, number, number, number, number, number, number, number, number];

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

function totalsOf(r: UsageRow): Totals {
  return {
    input_tokens: r[4],
    output_tokens: r[5],
    cache_creation_tokens: r[6],
    cache_read_tokens: r[7],
    cost_usd: r[8],
  };
}

function add(into: Totals, r: UsageRow): void {
  into.input_tokens += r[4];
  into.output_tokens += r[5];
  into.cache_creation_tokens += r[6];
  into.cache_read_tokens += r[7];
  into.cost_usd += r[8];
}

/** Adds a row to the total kept under `key`, starting it with `fields` if it's new. */
function addTo<T extends object>(
  map: Map<string, T & Totals>,
  key: string,
  fields: T,
  r: UsageRow,
): void {
  const t = map.get(key);
  if (t) add(t, r);
  else map.set(key, { ...fields, ...totalsOf(r) });
}

/**
 * GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?days=N, or ?all=1) —
 * usage per day, split by machine, by model and by tool, and each machine's
 * usage per tool for the whole period. Defaults to the last 30 days.
 *
 * With detail=1 it answers with the rows themselves instead, for the
 * Overview to total and filter in the browser. Over 92 days, where the chart
 * shows weeks or months, the rows are summed per week or month: a chart point
 * needs no more, and it keeps the Worker within the free plan's CPU time.
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
  const all = query.data.all === "1";
  let from = all
    ? addDays(to, -(MAX_SPAN_DAYS - 1))
    : (query.data.from ?? addDays(to, -((query.data.days ?? 30) - 1)));
  if (from > to) fail(400, "invalid_request", { message: "from must not be after to" });
  if (daysBetween(from, to) > MAX_SPAN_DAYS) {
    fail(400, "invalid_request", { message: `at most ${MAX_SPAN_DAYS} days` });
  }

  const detail = query.data.detail === "1";
  const etag = `W/"${settings.dataVersion}:${settings.timezone}:${today}:${from}:${to}${all ? ":all" : ""}${detail ? ":detail2" : ""}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  if (all) {
    // Starts at the first day with usage (one index lookup).
    const first = await c.env.DB.prepare(
      "SELECT MIN(day) AS day FROM usage_daily WHERE day BETWEEN ?1 AND ?2",
    )
      .bind(from, to)
      .first<{ day: string | null }>();
    from = first?.day ?? to;
  }
  const bucket = detail ? bucketFor(daysBetween(from, to)) : "day";
  // Each (machine, tool, day, model) has one row, so daily rows need no
  // grouping: reading them in day order is one row read per row.
  const rows = await c.env.DB.prepare(
    bucket === "day"
      ? `SELECT day, machine_id, source, model, input_tokens, output_tokens,
                cache_creation_tokens, cache_read_tokens, cost_usd
           FROM usage_daily
          WHERE day BETWEEN ?1 AND ?2
          ORDER BY day`
      : `SELECT ${BUCKET_START[bucket]} AS start, machine_id, source, model,
                SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens),
                SUM(cache_read_tokens), SUM(cost_usd)
           FROM usage_daily
          WHERE day BETWEEN ?1 AND ?2
          GROUP BY start, machine_id, source, model`,
  )
    .bind(from, to)
    .raw<UsageRow>();

  const head = {
    timezone: settings.timezone,
    today,
    from,
    to,
    /** Every tool the dashboard has seen, in the order they first appeared. */
    tools: settings.tools,
    /** Every model the dashboard has seen, in the order they first appeared. */
    models: settings.models,
  };

  if (detail) {
    const days = indexer();
    const machines = indexer();
    const sources = indexer();
    const models = indexer();
    const out: DetailRow[] = rows.map((r) => [
      days.of(r[0]),
      machines.of(r[1]),
      sources.of(r[2]),
      models.of(r[3]),
      r[4],
      r[5],
      r[6],
      r[7],
      r[8],
    ]);
    return c.json(
      {
        ...head,
        /** What each row's day stands for: a day, or the first day of a week or month. */
        bucket,
        detail: {
          days: days.list,
          machines: machines.list,
          sources: sources.list,
          models: models.list,
          rows: out,
        },
      },
      200,
      { etag },
    );
  }

  const byMachine = new Map<string, Totals & { day: string; machine_id: string }>();
  const byModel = new Map<string, Totals & { day: string; model: string }>();
  const bySource = new Map<string, Totals & { day: string; source: string }>();
  const machineSource = new Map<string, Totals & { machine_id: string; source: string }>();
  for (const r of rows) {
    const [day, machine_id, source, model] = r;
    addTo(byMachine, `${day}|${machine_id}`, { day, machine_id }, r);
    addTo(byModel, `${day}|${model}`, { day, model }, r);
    addTo(bySource, `${day}|${source}`, { day, source }, r);
    addTo(machineSource, `${machine_id}|${source}`, { machine_id, source }, r);
  }
  return c.json(
    {
      ...head,
      by_day_machine: [...byMachine.values()],
      by_day_model: [...byModel.values()],
      by_day_source: [...bySource.values()],
      by_machine_source: [...machineSource.values()],
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
