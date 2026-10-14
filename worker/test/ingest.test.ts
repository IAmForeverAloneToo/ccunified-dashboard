import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, payload, startWorker, type TestWorker } from "./harness";

let w: TestWorker;

beforeAll(async () => {
  w = await startWorker();
});
afterAll(() => w.dispose());

async function upload(token: string, body: unknown, headers: Record<string, string> = {}) {
  return w.fetch(
    "/agent/ingest",
    jsonInit("POST", body, { headers: { authorization: `Bearer ${token}`, ...headers } }),
  );
}

/** Lets the next upload from this machine through the 1-second rate limit. */
async function allowNextUpload(machineId: string) {
  await w.sql("UPDATE machines SET last_seen_at = last_seen_at - 5000 WHERE id = ?1", machineId);
}

async function rows(machineId: string) {
  return w.sql(
    "SELECT day, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd FROM usage_daily WHERE machine_id = ?1 ORDER BY day, model",
    machineId,
  );
}

async function dataVersion() {
  const [row] = await w.sql("SELECT value FROM settings WHERE key = 'data_version'");
  return Number(row?.value);
}

describe("authentication", () => {
  test("rejects a missing key", async () => {
    const res = await w.fetch("/agent/ingest", jsonInit("POST", payload()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  test("rejects an unknown key", async () => {
    const res = await upload(`ccu_m_${"A".repeat(43)}`, payload());
    expect(res.status).toBe(401);
  });

  test("rejects a revoked machine with a specific error", async () => {
    const m = await w.createMachine();
    await w.sql("UPDATE machines SET revoked_at = 1 WHERE id = ?1", m.id);
    const res = await upload(m.token, payload());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "machine_revoked" });
  });
});

describe("storing usage", () => {
  test("stores rows and updates the machine", async () => {
    const m = await w.createMachine();
    const before = await dataVersion();
    const res = await upload(m.token, payload());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      changed_rows: 1,
      timezone: "UTC",
      server_version: "test",
    });

    expect(await rows(m.id)).toEqual([
      {
        day: "2026-10-12",
        model: "claude-opus-5-5",
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_tokens: 300,
        cache_read_tokens: 400,
        cost_usd: 1.5,
      },
    ]);
    const [machine] = await w.sql(
      "SELECT os, agent_version, ccusage_version, last_seen_at FROM machines WHERE id = ?1",
      m.id,
    );
    expect(machine).toMatchObject({
      os: "windows",
      agent_version: "0.1.0",
      ccusage_version: "20.0.31",
    });
    expect(machine?.last_seen_at).toBeTypeOf("number");
    expect(await dataVersion()).toBe(before + 1);
  });

  test("re-sending the same data changes nothing", async () => {
    const m = await w.createMachine();
    await upload(m.token, payload());
    await allowNextUpload(m.id);
    const before = await dataVersion();
    const res = await upload(m.token, payload());
    expect(await res.json()).toMatchObject({ ok: true, changed_rows: 0 });
    expect(await dataVersion()).toBe(before);
  });

  test("updated numbers replace the old ones", async () => {
    const m = await w.createMachine();
    await upload(m.token, payload());
    await allowNextUpload(m.id);
    const next = payload();
    next.days = [
      {
        date: "2026-10-12",
        source: "claude",
        models: [{ ...next.days[0]?.models[0], output_tokens: 999 }],
      },
    ] as typeof next.days;
    const res = await upload(m.token, next);
    expect(await res.json()).toMatchObject({ changed_rows: 1 });
    expect((await rows(m.id))[0]).toMatchObject({ output_tokens: 999 });
  });

  test("the range is replaced as a whole; rows outside it are kept", async () => {
    const m = await w.createMachine();
    const model = (name: string) => ({
      model: name,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_tokens: 1,
      cache_read_tokens: 1,
      cost_usd: 0.01,
    });
    await upload(
      m.token,
      payload({
        range: { from: "2026-10-01", to: "2026-10-13" },
        days: [
          { date: "2026-10-01", source: "claude", models: [model("a")] },
          { date: "2026-10-10", source: "claude", models: [model("a"), model("b")] },
          { date: "2026-10-12", source: "claude", models: [model("a")] },
        ],
      }),
    );
    await allowNextUpload(m.id);
    // A new upload for 10-07..10-13 that no longer has model b on 10-10, nor 10-12 at all.
    await upload(
      m.token,
      payload({
        range: { from: "2026-10-07", to: "2026-10-13" },
        days: [{ date: "2026-10-10", source: "claude", models: [model("a")] }],
      }),
    );
    const stored = (await rows(m.id)).map((r) => `${r.day} ${r.model}`);
    expect(stored).toEqual(["2026-10-01 a", "2026-10-10 a"]);
  });

  test("one machine's upload never touches another machine's rows", async () => {
    const a = await w.createMachine();
    const b = await w.createMachine();
    await upload(a.token, payload());
    await upload(b.token, payload({ days: [] }));
    expect(await rows(a.id)).toHaveLength(1);
  });

  test("handles very large token counts and tiny costs exactly", async () => {
    const m = await w.createMachine();
    const big = payload({
      days: [
        {
          date: "2026-10-12",
          source: "claude",
          models: [
            {
              model: "claude-opus-5-5",
              input_tokens: 999_999_999_999_999,
              output_tokens: 0,
              cache_creation_tokens: 0,
              cache_read_tokens: 0,
              cost_usd: 0.0000034999999999999995,
            },
          ],
        },
      ],
    });
    expect((await upload(m.token, big)).status).toBe(200);
    expect((await rows(m.id))[0]).toMatchObject({
      input_tokens: 999_999_999_999_999,
      cost_usd: 0.0000034999999999999995,
    });
  });
});

describe("refusals", () => {
  test("a different time zone is refused with the dashboard's zone", async () => {
    const m = await w.createMachine();
    const res = await upload(m.token, payload({ timezone: "Europe/Paris" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "timezone_mismatch", timezone: "UTC" });
    expect(await rows(m.id)).toEqual([]);
  });

  test("invalid payloads are refused with the problems listed", async () => {
    const m = await w.createMachine();
    const res = await upload(m.token, payload({ schema_version: 99 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((i) => i.path)).toContain("schema_version");
  });

  test("non-JSON bodies are refused", async () => {
    const m = await w.createMachine();
    const res = await w.fetch("/agent/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${m.token}`, "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });

  test("bodies over 256 KiB are refused", async () => {
    const m = await w.createMachine();
    const res = await w.fetch("/agent/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(300 * 1024)}"}`,
    });
    expect(res.status).toBe(413);
  });

  test("uploads less than a second apart are rate-limited", async () => {
    const m = await w.createMachine();
    expect((await upload(m.token, payload())).status).toBe(200);
    const res = await upload(m.token, payload());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
  });
});
