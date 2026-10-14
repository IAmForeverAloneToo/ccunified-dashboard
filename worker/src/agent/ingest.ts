import type { Context } from "hono";
import type { AppEnv } from "../env";
import { INGEST_SCHEMA_VERSIONS, IngestPayload, LIMITS, sourcesOf } from "../ingest/schema";
import { fail, readJson } from "../lib/http";
import { bumpDataVersion, getSettings, parseList, setSetting } from "../lib/settings";
import { latestVersion, learnLatestVersion, pickLatest } from "../lib/updates";
import { SERVER_VERSION } from "../version";

/** Uploads from one machine closer together than this are refused (backfills wait and retry). */
const MIN_INTERVAL_MS = 1000;

/**
 * POST /agent/ingest — stores one machine's usage for a date range.
 *
 * All of the machine's rows inside `range` for the tools the upload covers are
 * replaced by the payload's rows, in a single transaction of a few statements
 * (the free plan allows 50 queries per request). Rows whose numbers did not
 * change are not rewritten.
 */
export async function ingest(c: Context<AppEnv>): Promise<Response> {
  const machine = c.get("machine");
  const now = Date.now();
  if (machine.last_seen_at !== null && now - machine.last_seen_at < MIN_INTERVAL_MS) {
    fail(429, "too_many_requests", { retry_after_seconds: 1 }, { "retry-after": "1" });
  }

  const payload = await readJson(c, IngestPayload, LIMITS.maxBodyBytes);
  const settings = await getSettings(c.env.DB);
  if (payload.timezone !== settings.timezone) {
    // The agent re-reads its history in the dashboard's time zone and uploads again.
    fail(409, "timezone_mismatch", { timezone: settings.timezone });
  }

  const rows = payload.days.flatMap((d) =>
    d.models.map((m) => ({
      source: d.source,
      day: d.date,
      model: m.model,
      i: m.input_tokens,
      o: m.output_tokens,
      cc: m.cache_creation_tokens,
      cr: m.cache_read_tokens,
      cost: m.cost_usd,
    })),
  );
  const keep = rows.map((r) => `${r.source}|${r.day}|${r.model}`);
  const db = c.env.DB;
  const a = payload.agent;
  const learned = learnLatestVersion(db, settings, a.version);

  // Remember which tools have reported usage: per machine, and for the whole
  // dashboard in the order they first appeared (the order of their colors).
  const reported = [...new Set(rows.map((r) => r.source))];
  const machineTools = mergeTools(parseList(machine.tools), reported);
  const dashboardTools = mergeTools(settings.tools, reported);
  const newTools =
    dashboardTools.length > settings.tools.length
      ? setSetting(db, "tools", JSON.stringify(dashboardTools))
      : null;

  const [, deleted, upserted] = await db.batch([
    db
      .prepare(
        `UPDATE machines
            SET last_seen_at = ?1, agent_version = ?2, os = ?3, arch = ?4,
                ccusage_version = ?5, sync_interval_minutes = ?6, tools = ?7
          WHERE id = ?8`,
      )
      .bind(
        now,
        a.version,
        a.os,
        a.arch,
        a.ccusage_version,
        a.sync_interval_minutes,
        JSON.stringify(machineTools),
        machine.id,
      ),
    db
      .prepare(
        `DELETE FROM usage_daily
          WHERE machine_id = ?1
            AND source IN (SELECT value FROM json_each(?2))
            AND day BETWEEN ?3 AND ?4
            AND (source || '|' || day || '|' || model) NOT IN (SELECT value FROM json_each(?5))`,
      )
      .bind(
        machine.id,
        JSON.stringify(sourcesOf(payload)),
        payload.range.from,
        payload.range.to,
        JSON.stringify(keep),
      ),
    db
      .prepare(
        `INSERT INTO usage_daily (machine_id, source, day, model, input_tokens, output_tokens,
                                  cache_creation_tokens, cache_read_tokens, cost_usd, updated_at)
         SELECT ?1, json_extract(value, '$.source'), json_extract(value, '$.day'),
                json_extract(value, '$.model'), json_extract(value, '$.i'),
                json_extract(value, '$.o'), json_extract(value, '$.cc'),
                json_extract(value, '$.cr'), json_extract(value, '$.cost'), ?2
           FROM json_each(?3) WHERE true
         ON CONFLICT (machine_id, source, day, model) DO UPDATE SET
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cost_usd = excluded.cost_usd,
                updated_at = excluded.updated_at
          WHERE usage_daily.input_tokens IS NOT excluded.input_tokens
             OR usage_daily.output_tokens IS NOT excluded.output_tokens
             OR usage_daily.cache_creation_tokens IS NOT excluded.cache_creation_tokens
             OR usage_daily.cache_read_tokens IS NOT excluded.cache_read_tokens
             OR usage_daily.cost_usd IS NOT excluded.cost_usd`,
      )
      .bind(machine.id, now, JSON.stringify(rows)),
    ...(learned ? [learned] : []),
    ...(newTools ? [newTools] : []),
  ]);

  const changed = (deleted?.meta.changes ?? 0) + (upserted?.meta.changes ?? 0);
  if (changed > 0) await bumpDataVersion(db).run();

  return c.json({
    ok: true,
    changed_rows: changed,
    timezone: settings.timezone,
    server_version: SERVER_VERSION,
    schema_versions: INGEST_SCHEMA_VERSIONS,
    latest_version: pickLatest(
      latestVersion(db, settings, c.executionCtx),
      learned ? a.version : null,
    ),
  });
}

/** `known` followed by the tools in `reported` it doesn't have yet. */
function mergeTools(known: string[], reported: string[]): string[] {
  return [...known, ...reported.filter((t) => !known.includes(t))];
}
