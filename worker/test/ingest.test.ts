import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, payload, splitSql, startWorker, type TestWorker } from "./harness";

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

describe("tools other than Claude Code (format 2)", () => {
  const usage = (name: string, n = 1) => ({
    model: name,
    input_tokens: n,
    output_tokens: n,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0.01,
  });
  const v2 = (
    sources: string[],
    days: unknown[],
    range = { from: "2026-10-07", to: "2026-10-13" },
  ) => payload({ schema_version: 2, sources, range, days });
  const stored = async (machineId: string) =>
    (
      await w.sql(
        "SELECT source, day, model FROM usage_daily WHERE machine_id = ?1 ORDER BY source, day, model",
        machineId,
      )
    ).map((r) => `${r.source} ${r.day} ${r.model}`);
  const dashboardTools = async () => {
    const [row] = await w.sql("SELECT value FROM settings WHERE key = 'tools'");
    return JSON.parse(String(row?.value)) as string[];
  };
  const machineTools = async (id: string) => {
    const [row] = await w.sql("SELECT tools FROM machines WHERE id = ?1", id);
    return JSON.parse(String(row?.tools)) as string[];
  };

  test("stores each tool's usage and says which formats the dashboard accepts", async () => {
    const m = await w.createMachine();
    const res = await upload(
      m.token,
      v2(
        ["claude", "codex", "opencode"],
        [
          { date: "2026-10-12", source: "claude", models: [usage("claude-opus-5-5")] },
          { date: "2026-10-12", source: "codex", models: [usage("gpt-5.5")] },
          { date: "2026-10-13", source: "opencode", models: [usage("anthropic/claude-opus-5-5")] },
        ],
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed_rows: 3, schema_versions: [1, 2] });
    expect(await stored(m.id)).toEqual([
      "claude 2026-10-12 claude-opus-5-5",
      "codex 2026-10-12 gpt-5.5",
      "opencode 2026-10-13 anthropic/claude-opus-5-5",
    ]);
  });

  test("only the tools an upload covers are replaced", async () => {
    const m = await w.createMachine();
    await upload(
      m.token,
      v2(
        ["claude", "codex"],
        [
          { date: "2026-10-12", source: "claude", models: [usage("claude-opus-5-5")] },
          { date: "2026-10-12", source: "codex", models: [usage("gpt-5.5")] },
        ],
      ),
    );
    await allowNextUpload(m.id);
    // Covers Claude Code only (as when ccusage could only read Claude Code): Codex stays.
    await upload(m.token, v2(["claude"], []));
    expect(await stored(m.id)).toEqual(["codex 2026-10-12 gpt-5.5"]);

    await allowNextUpload(m.id);
    // A format 1 upload from an older ccunified covers Claude Code only, too.
    await upload(m.token, payload({ days: [] }));
    expect(await stored(m.id)).toEqual(["codex 2026-10-12 gpt-5.5"]);

    await allowNextUpload(m.id);
    // Covering Codex with no usage clears it.
    await upload(m.token, v2(["claude", "codex"], []));
    expect(await stored(m.id)).toEqual([]);
  });

  test("remembers each machine's tools, and the dashboard's in the order they first appeared", async () => {
    const before = await dashboardTools();
    expect(before).not.toContain("gemini");
    expect(before).not.toContain("qwen");
    const a = await w.createMachine();
    const b = await w.createMachine();
    // Covered but without usage: not a tool this machine reports.
    await upload(
      a.token,
      v2(
        ["gemini", "qwen"],
        [{ date: "2026-10-10", source: "gemini", models: [usage("gemini-3-pro")] }],
      ),
    );
    await upload(
      b.token,
      v2(
        ["claude", "qwen", "gemini"],
        [
          { date: "2026-10-11", source: "qwen", models: [usage("qwen3-coder")] },
          { date: "2026-10-11", source: "gemini", models: [] },
        ],
      ),
    );
    expect(await machineTools(a.id)).toEqual(["gemini"]);
    expect(await machineTools(b.id)).toEqual(["qwen"]);
    expect(await dashboardTools()).toEqual([...before, "gemini", "qwen"]);

    // Later uploads add to the lists; nothing is forgotten or reordered.
    await allowNextUpload(a.id);
    await upload(
      a.token,
      v2(
        ["gemini", "qwen"],
        [{ date: "2026-10-12", source: "qwen", models: [usage("qwen3-coder")] }],
      ),
    );
    expect(await machineTools(a.id)).toEqual(["gemini", "qwen"]);
    expect(await dashboardTools()).toEqual([...before, "gemini", "qwen"]);
  });

  test("one upload adds at most 20 new tools, and the list stops at 100", async () => {
    const before = await dashboardTools();
    const m = await w.createMachine();
    const sources = Array.from({ length: 30 }, (_, i) => `flood${i}`);
    const days = sources.map((source) => ({ date: "2026-10-12", source, models: [usage("x")] }));
    expect((await upload(m.token, v2(sources, days))).status).toBe(200);
    const after = await dashboardTools();
    expect(after).toEqual([...before, ...sources.slice(0, 20)]);
    expect(await machineTools(m.id)).toEqual(sources.slice(0, 20));
    // The usage of the tools left out is stored all the same.
    expect(await stored(m.id)).toHaveLength(30);

    const full = Array.from({ length: 100 }, (_, i) => `full${i}`);
    await w.sql("UPDATE settings SET value = ?1 WHERE key = 'tools'", JSON.stringify(full));
    await allowNextUpload(m.id);
    await upload(
      m.token,
      v2(["another"], [{ date: "2026-10-12", source: "another", models: [usage("x")] }]),
    );
    expect(await dashboardTools()).toEqual(full);
    await w.sql("UPDATE settings SET value = ?1 WHERE key = 'tools'", JSON.stringify(after));
  });

  test("format 2 rules are enforced", async () => {
    const m = await w.createMachine();
    const refused = async (body: unknown) => {
      await allowNextUpload(m.id);
      const res = await upload(m.token, body);
      expect(res.status).toBe(400);
    };
    await refused(v2([], []));
    await refused(v2(["Claude Code"], []));
    await refused(v2(["claude", "claude"], []));
    await refused(
      v2(["claude"], [{ date: "2026-10-12", source: "codex", models: [usage("gpt-5.5")] }]),
    );
    // Format 1 is Claude Code only.
    await refused(
      payload({ days: [{ date: "2026-10-12", source: "codex", models: [usage("gpt-5.5")] }] }),
    );
    // At most 1000 tool-days per upload.
    const sources = Array.from({ length: 11 }, (_, i) => `tool${i}`);
    const days = sources.flatMap((source) =>
      Array.from({ length: 91 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
        source,
        models: [],
      })),
    );
    await refused(v2(sources, days, { from: "2026-07-01", to: "2026-09-29" }));
    await allowNextUpload(m.id);
    const ok = await upload(
      m.token,
      v2(sources, days.slice(0, 1000), { from: "2026-07-01", to: "2026-09-29" }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("the database update for format 2", () => {
  test("marks earlier usage as Claude Code's", async () => {
    const m = await w.createMachine();
    const idle = await w.createMachine();
    await upload(m.token, payload());
    // Undo what the Worker recorded, then run the migration's data statements again.
    await w.sql("UPDATE machines SET tools = '[]'");
    await w.sql("DELETE FROM settings WHERE key = 'tools'");
    const migration = readFileSync(
      join(import.meta.dirname, "../migrations/0002_tools.sql"),
      "utf8",
    );
    for (const statement of splitSql(migration).filter((q) => !q.startsWith("ALTER"))) {
      await w.sql(statement);
    }
    const [row] = await w.sql("SELECT value FROM settings WHERE key = 'tools'");
    expect(row?.value).toBe('["claude"]');
    const tools = async (id: string) =>
      (await w.sql("SELECT tools FROM machines WHERE id = ?1", id))[0]?.tools;
    expect(await tools(m.id)).toBe('["claude"]');
    expect(await tools(idle.id)).toBe("[]");
  });
});

describe("models in the order they first appeared", () => {
  const usage = (name: string) => ({
    model: name,
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0.01,
  });
  const dashboardModels = async () => {
    const [row] = await w.sql("SELECT value FROM settings WHERE key = 'models'");
    return JSON.parse(String(row?.value)) as string[];
  };

  test("uploads add new models to the end; nothing is reordered", async () => {
    const before = await dashboardModels();
    const m = await w.createMachine();
    await upload(
      m.token,
      payload({
        schema_version: 2,
        sources: ["claude", "kimi"],
        days: [
          { date: "2026-10-11", source: "kimi", models: [usage("k3")] },
          { date: "2026-10-12", source: "claude", models: [usage("claude-mythos-5-1")] },
        ],
      }),
    );
    expect(await dashboardModels()).toEqual([
      ...before.filter((x) => x !== "k3" && x !== "claude-mythos-5-1"),
      ...["k3", "claude-mythos-5-1"].filter((x) => !before.includes(x)),
    ]);
    const after = await dashboardModels();
    await allowNextUpload(m.id);
    await upload(
      m.token,
      payload({
        days: [{ date: "2026-10-12", source: "claude", models: [usage("claude-mythos-5-1")] }],
      }),
    );
    expect(await dashboardModels()).toEqual(after);
  });

  test("the database update lists earlier usage's models by the day each first appeared", async () => {
    const m = await w.createMachine();
    await upload(
      m.token,
      payload({
        range: { from: "2020-01-01", to: "2020-01-03" },
        days: [
          { date: "2020-01-01", source: "claude", models: [usage("zz-first"), usage("aa-first")] },
          { date: "2020-01-03", source: "claude", models: [usage("zz-first"), usage("mm-later")] },
        ],
      }),
    );
    await w.sql("DELETE FROM settings WHERE key = 'models'");
    const migration = readFileSync(
      join(import.meta.dirname, "../migrations/0003_models.sql"),
      "utf8",
    );
    for (const statement of splitSql(migration)) await w.sql(statement);
    const models = await dashboardModels();
    // Same first day: by name. Every model in the database is listed once.
    expect(models.slice(0, 3)).toEqual(["aa-first", "zz-first", "mm-later"]);
    const distinct = await w.sql("SELECT DISTINCT model FROM usage_daily");
    expect(models.sort()).toEqual(distinct.map((r) => String(r.model)).sort());
  });

  test("one upload adds at most 100 new models, and the list stops at 1000", async () => {
    const before = await dashboardModels();
    const m = await w.createMachine();
    const days = ["2026-09-10", "2026-09-11", "2026-09-12"].map((date, d) => ({
      date,
      source: "claude",
      models: Array.from({ length: 50 }, (_, i) => usage(`flood-${d * 50 + i}`)),
    }));
    const res = await upload(
      m.token,
      payload({ range: { from: "2026-09-10", to: "2026-09-12" }, days }),
    );
    expect(res.status).toBe(200);
    const after = await dashboardModels();
    expect(after).toEqual([...before, ...Array.from({ length: 100 }, (_, i) => `flood-${i}`)]);
    // The usage of the models left out is stored all the same.
    const [stored] = await w.sql(
      "SELECT COUNT(DISTINCT model) AS n FROM usage_daily WHERE machine_id = ?1",
      m.id,
    );
    expect(stored?.n).toBe(150);

    const full = Array.from({ length: 1000 }, (_, i) => `full-${i}`);
    await w.sql("UPDATE settings SET value = ?1 WHERE key = 'models'", JSON.stringify(full));
    await allowNextUpload(m.id);
    await upload(
      m.token,
      payload({ days: [{ date: "2026-10-12", source: "claude", models: [usage("one-more")] }] }),
    );
    expect(await dashboardModels()).toEqual(full);
    await w.sql("UPDATE settings SET value = ?1 WHERE key = 'models'", JSON.stringify(after));
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

describe("the newest release", () => {
  const known = async () => {
    const [row] = await w.sql("SELECT value FROM settings WHERE key = 'latest_version'");
    return (row?.value as string | undefined) ?? null;
  };
  const withVersion = (version: string) => payload({ agent: { ...payload().agent, version } });

  test("comes from the dashboard's own check, never from what a machine reports", async () => {
    await w.sql(
      "INSERT INTO settings (key, value) VALUES ('latest_version', '0.9.1') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    const viewer = await w.createUser();
    const bold = await w.createMachine({ name: "bold" });
    const res = await upload(bold.token, withVersion("99.0.0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ latest_version: "0.9.1" });
    expect(await known()).toBe("0.9.1");

    // A machine on an older release is told to update.
    const behind = await w.createMachine({ name: "behind" });
    expect(await (await upload(behind.token, withVersion("0.8.0"))).json()).toMatchObject({
      latest_version: "0.9.1",
    });
    const list = (await (await w.fetch("/api/machines", { cookie: viewer.cookie })).json()) as {
      latest_version: string;
      machines: { name: string; update_available: boolean }[];
    };
    expect(list.latest_version).toBe("0.9.1");
    expect(list.machines.find((m) => m.name === "behind")?.update_available).toBe(true);
    expect(list.machines.find((m) => m.name === "bold")?.update_available).toBe(false);
  });
});
