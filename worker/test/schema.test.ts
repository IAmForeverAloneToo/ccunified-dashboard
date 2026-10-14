import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { IngestPayload } from "../src/ingest/schema";

const schemaDir = join(import.meta.dirname, "../../schema");
const examples = (kind: "valid" | "invalid") =>
  readdirSync(join(schemaDir, "examples", kind))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(schemaDir, "examples", kind, f), "utf8"))]);

function generatedJsonSchema(): string {
  const generated = z.toJSONSchema(IngestPayload, { target: "draft-2020-12", io: "input" });
  return `${JSON.stringify(
    {
      ...generated,
      $id: "https://github.com/IAmForeverAloneToo/ccunified-dashboard/schema/ingest.schema.json",
      title: "ccunified ingest payload",
      description:
        "Generated from worker/src/ingest/schema.ts. The Worker and agent also enforce rules JSON Schema cannot express: one entry per source and date, each model once per day, each source listed once, and every day's source listed in sources.",
    },
    null,
    2,
  )}\n`;
}

describe("ingest schema", () => {
  test("schema/ingest.schema.json is generated from the Zod schema", () => {
    const file = join(schemaDir, "ingest.schema.json");
    const expected = generatedJsonSchema();
    if (process.env.UPDATE_SCHEMA === "1") writeFileSync(file, expected);
    expect(readFileSync(file, "utf8"), "run: UPDATE_SCHEMA=1 npm test -w worker").toBe(expected);
  });

  test.each(examples("valid"))("accepts %s", (_name, payload) => {
    const result = IngestPayload.safeParse(payload);
    expect(result.error?.issues).toBeUndefined();
  });

  test.each(examples("invalid"))("rejects %s", (_name, payload) => {
    expect(IngestPayload.safeParse(payload).success).toBe(false);
  });
});
