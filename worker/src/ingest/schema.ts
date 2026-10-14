import { z } from "zod";

// The upload format sent by `ccunified sync` to POST /agent/ingest.
//
// This Zod schema is the single source of truth: schema/ingest.schema.json is
// generated from it (see test/schema.test.ts), and the Go agent's tests check
// their payloads against that JSON Schema and the shared examples in
// schema/examples/.
//
// Format 2 carries usage from every tool ccusage reads (Claude Code, Codex,
// Gemini CLI, …). Format 1, from ccunified 0.1, carries Claude Code only and
// is still accepted.

/** The newest upload format. */
export const INGEST_SCHEMA_VERSION = 2;

/** Every upload format this dashboard accepts, oldest first. */
export const INGEST_SCHEMA_VERSIONS = [1, 2] as const;

/** Upper bounds that keep a single upload small. The agent splits larger backfills. */
export const LIMITS = {
  /** Longest date range (inclusive) one upload may cover. */
  maxRangeDays: 100,
  /** Format 1: one entry per day. */
  maxDaysPerUpload: 100,
  /** Format 2: one entry per tool and day. */
  maxEntriesPerUpload: 1000,
  maxSources: 64,
  maxModelsPerDay: 50,
  maxBodyBytes: 256 * 1024,
} as const;

/**
 * A tool's id, as ccusage names it: "claude" (Claude Code), "codex",
 * "gemini", "copilot", "opencode", …
 */
export const SourceId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "a lowercase tool id such as claude or codex");

const MAX_TOKENS = 1_000_000_000_000_000; // 1e15, well inside the safe integer range

const versionString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.+-]+$/, "letters, digits, '.', '+' and '-' only");

const tokenCount = z.int().min(0).max(MAX_TOKENS);

export const ModelUsage = z.strictObject({
  model: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/, "printable ASCII without spaces"),
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_tokens: tokenCount,
  cache_read_tokens: tokenCount,
  cost_usd: z.number().min(0).max(1_000_000_000),
});

const models = z
  .array(ModelUsage)
  .max(LIMITS.maxModelsPerDay)
  .refine((list) => new Set(list.map((m) => m.model)).size === list.length, {
    message: "each model may appear only once per day",
  });

/** One tool's usage on one day, split by model. */
export const DayUsage = z.strictObject({
  date: z.iso.date(),
  source: SourceId,
  models,
});

const isoDate = z.iso.date();

/** Number of calendar days from `from` to `to`, inclusive. */
export function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

const agent = z.strictObject({
  version: versionString,
  os: z.enum(["windows", "linux", "darwin"]),
  arch: z.enum(["amd64", "arm64"]),
  ccusage_version: versionString,
  sync_interval_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
});

/**
 * The dates an upload covers. The server replaces all of this machine's rows
 * in the range (for the tools the upload covers), so days with no usage are
 * cleared too.
 */
const range = z.strictObject({ from: isoDate, to: isoDate });

const V1 = z.strictObject({
  schema_version: z.literal(1),
  agent,
  timezone: z.string().min(1).max(64),
  range,
  days: z.array(DayUsage.extend({ source: z.literal("claude") })).max(LIMITS.maxDaysPerUpload),
});

const V2 = z
  .strictObject({
    schema_version: z.literal(2),
    agent,
    timezone: z.string().min(1).max(64),
    range,
    /**
     * The tools this upload covers: every tool ccusage looked for, whether or
     * not it found any usage. Only these tools' rows in the range are replaced.
     */
    sources: z.array(SourceId).min(1).max(LIMITS.maxSources),
    days: z.array(DayUsage).max(LIMITS.maxEntriesPerUpload),
  })
  .refine((p) => new Set(p.sources).size === p.sources.length, {
    message: "each source may appear only once",
    path: ["sources"],
  })
  .refine((p) => p.days.every((d) => p.sources.includes(d.source)), {
    message: "every day's source must be listed in sources",
    path: ["days"],
  });

export const IngestPayload = z
  .discriminatedUnion("schema_version", [V1, V2])
  .refine((p) => p.range.from <= p.range.to, {
    message: "range.from must not be after range.to",
    path: ["range"],
  })
  .refine((p) => daySpan(p.range.from, p.range.to) <= LIMITS.maxRangeDays, {
    message: `range may cover at most ${LIMITS.maxRangeDays} days`,
    path: ["range"],
  })
  .refine((p) => p.days.every((d) => d.date >= p.range.from && d.date <= p.range.to), {
    message: "every day must fall inside range",
    path: ["days"],
  })
  .refine((p) => new Set(p.days.map((d) => `${d.source}/${d.date}`)).size === p.days.length, {
    message: "each (source, date) may appear only once",
    path: ["days"],
  });

export type IngestPayload = z.infer<typeof IngestPayload>;
export type DayUsage = z.infer<typeof DayUsage>;
export type ModelUsage = z.infer<typeof ModelUsage>;

/** The tools an upload covers; format 1 is Claude Code only. */
export function sourcesOf(p: IngestPayload): string[] {
  return p.schema_version === 1 ? ["claude"] : p.sources;
}
