import { z } from "zod";

// The upload format sent by `ccunified sync` to POST /agent/ingest.
//
// This Zod schema is the single source of truth: schema/ingest.schema.json is
// generated from it (see test/schema.test.ts), and the Go agent's tests check
// their payloads against that JSON Schema and the shared examples in
// schema/examples/.

export const INGEST_SCHEMA_VERSION = 1;

/** Upper bounds that keep a single upload small. The agent splits larger backfills. */
export const LIMITS = {
  maxDaysPerUpload: 100,
  maxModelsPerDay: 50,
  maxBodyBytes: 256 * 1024,
} as const;

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

export const DayUsage = z
  .strictObject({
    date: z.iso.date(),
    source: z.enum(["claude"]),
    models: z.array(ModelUsage).max(LIMITS.maxModelsPerDay),
  })
  .refine((day) => new Set(day.models.map((m) => m.model)).size === day.models.length, {
    message: "each model may appear only once per day",
    path: ["models"],
  });

export const IngestPayload = z
  .strictObject({
    schema_version: z.literal(INGEST_SCHEMA_VERSION),
    agent: z.strictObject({
      version: versionString,
      os: z.enum(["windows", "linux", "darwin"]),
      arch: z.enum(["amd64", "arm64"]),
      ccusage_version: versionString,
      sync_interval_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    }),
    timezone: z.string().min(1).max(64),
    days: z.array(DayUsage).max(LIMITS.maxDaysPerUpload),
  })
  .refine(
    (p) => new Set(p.days.map((d) => `${d.source}/${d.date}`)).size === p.days.length,
    { message: "each (source, date) may appear only once", path: ["days"] },
  );

export type IngestPayload = z.infer<typeof IngestPayload>;
export type DayUsage = z.infer<typeof DayUsage>;
export type ModelUsage = z.infer<typeof ModelUsage>;
