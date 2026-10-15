import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, payload, startWorker, type TestWorker } from "./harness";

let w: TestWorker;
let admin: { id: string; cookie: string };
let viewer: { id: string; cookie: string };

beforeAll(async () => {
  w = await startWorker();
  admin = await w.createUser({ role: "admin", username: "alice" });
  viewer = await w.createUser({ role: "viewer", username: "victor" });
});
afterAll(() => w.dispose());

const model = (name: string, n: number, cost: number) => ({
  model: name,
  input_tokens: n,
  output_tokens: n * 2,
  cache_creation_tokens: n * 3,
  cache_read_tokens: n * 4,
  cost_usd: cost,
});

/** The answer to /api/summary?detail=1. */
interface Detailed {
  bucket: string;
  detail: {
    days: string[];
    machines: string[];
    sources: string[];
    models: string[];
    rows: [number, number, number, number, number, number, number, number, number][];
  };
}

/** Detail rows as "day machine tool model input", sorted. */
function readRows({ detail: d }: Detailed): string[] {
  return d.rows
    .map(
      ([t, m, s, k, input]) =>
        `${d.days[t]} ${d.machines[m]} ${d.sources[s]} ${d.models[k]} ${input}`,
    )
    .sort();
}

describe("access control", () => {
  test.each(["/api/me", "/api/summary", "/api/machines", "/api/settings"])(
    "%s requires a login",
    async (path) => {
      const res = await w.fetch(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "not_logged_in" });
    },
  );

  test("a forged or expired session is not accepted", async () => {
    expect((await w.fetch("/api/me", { cookie: "__Host-ccu_session=forged" })).status).toBe(401);
    const user = await w.createUser({ role: "admin" });
    await w.sql("UPDATE sessions SET expires_at = 1 WHERE user_id = ?1", user.id);
    expect((await w.fetch("/api/me", { cookie: user.cookie })).status).toBe(401);
  });

  test("a disabled user's session stops working", async () => {
    const user = await w.createUser({ role: "admin" });
    expect((await w.fetch("/api/me", { cookie: user.cookie })).status).toBe(200);
    await w.sql("UPDATE users SET disabled_at = 1 WHERE id = ?1", user.id);
    expect((await w.fetch("/api/me", { cookie: user.cookie })).status).toBe(401);
  });

  test("/api/me describes the logged-in user", async () => {
    const res = await w.fetch("/api/me", { cookie: viewer.cookie });
    expect(await res.json()).toEqual({
      id: viewer.id,
      username: "victor",
      role: "viewer",
      departments: [],
      totp_enabled: false,
      must_change_password: false,
    });
  });

  test("viewers cannot change anything", async () => {
    const m = await w.createMachine();
    const calls: [string, RequestInit][] = [
      [`/api/machines/${m.id}`, jsonInit("PATCH", { name: "x" })],
      [`/api/machines/${m.id}`, { method: "DELETE" }],
      ["/api/settings", jsonInit("PATCH", { timezone: "UTC" })],
    ];
    for (const [path, init] of calls) {
      const res = await w.fetch(path, { ...init, cookie: viewer.cookie });
      expect(res.status, `${init.method} ${path}`).toBe(403);
    }
  });

  test("changes from another site are refused even with a valid session", async () => {
    const m = await w.createMachine();
    for (const origin of ["https://evil.example", "null"]) {
      const res = await w.fetch(`/api/machines/${m.id}`, {
        ...jsonInit("PATCH", { name: "pwned" }),
        headers: { "content-type": "application/json", origin },
        cookie: admin.cookie,
      });
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
  });
});

describe("summary", () => {
  test("adds up usage per machine and per model, and supports ETags", async () => {
    const a = await w.createMachine({ name: "summary-a" });
    const b = await w.createMachine({ name: "summary-b" });
    const range = { from: "2026-09-01", to: "2026-09-02" };
    const up = (token: string, body: unknown) =>
      w.fetch(
        "/agent/ingest",
        jsonInit("POST", body, { headers: { authorization: `Bearer ${token}` } }),
      );
    await up(
      a.token,
      payload({
        range,
        days: [
          {
            date: "2026-09-01",
            source: "claude",
            models: [model("opus", 10, 1), model("haiku", 1, 0.1)],
          },
          { date: "2026-09-02", source: "claude", models: [model("opus", 5, 0.5)] },
        ],
      }),
    );
    await up(
      b.token,
      payload({
        range,
        days: [{ date: "2026-09-01", source: "claude", models: [model("opus", 7, 0.7)] }],
      }),
    );

    const res = await w.fetch("/api/summary?from=2026-09-01&to=2026-09-02", {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      by_day_machine: { day: string; machine_id: string; input_tokens: number; cost_usd: number }[];
      by_day_model: { day: string; model: string; input_tokens: number; output_tokens: number }[];
      from: string;
      to: string;
    };
    expect(body.from).toBe("2026-09-01");
    const perMachine = Object.fromEntries(
      body.by_day_machine.map((r) => [`${r.day} ${r.machine_id}`, r.input_tokens]),
    );
    expect(perMachine).toEqual({
      [`2026-09-01 ${a.id}`]: 11,
      [`2026-09-01 ${b.id}`]: 7,
      [`2026-09-02 ${a.id}`]: 5,
    });
    const perModel = Object.fromEntries(
      body.by_day_model.map((r) => [`${r.day} ${r.model}`, [r.input_tokens, r.output_tokens]]),
    );
    expect(perModel).toEqual({
      "2026-09-01 opus": [17, 34],
      "2026-09-01 haiku": [1, 2],
      "2026-09-02 opus": [5, 10],
    });

    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await w.fetch("/api/summary?from=2026-09-01&to=2026-09-02", {
      cookie: viewer.cookie,
      headers: { "if-none-match": etag ?? "" },
    });
    expect(again.status).toBe(304);
  });

  test("splits usage by tool, overall and per machine", async () => {
    const a = await w.createMachine({ name: "tools-a" });
    const b = await w.createMachine({ name: "tools-b" });
    const range = { from: "2026-08-01", to: "2026-08-02" };
    const up = (token: string, days: unknown[]) =>
      w.fetch(
        "/agent/ingest",
        jsonInit(
          "POST",
          payload({ schema_version: 2, sources: ["claude", "codex"], range, days }),
          {
            headers: { authorization: `Bearer ${token}` },
          },
        ),
      );
    await up(a.token, [
      { date: "2026-08-01", source: "claude", models: [model("opus", 10, 1)] },
      { date: "2026-08-01", source: "codex", models: [model("gpt-5.5", 3, 0.3)] },
      { date: "2026-08-02", source: "codex", models: [model("gpt-5.5", 2, 0.2)] },
    ]);
    await up(b.token, [
      { date: "2026-08-02", source: "codex", models: [model("gpt-5.5", 1, 0.1)] },
    ]);

    const res = await w.fetch("/api/summary?from=2026-08-01&to=2026-08-02", {
      cookie: viewer.cookie,
    });
    const body = (await res.json()) as {
      tools: string[];
      models: string[];
      by_day_source: { day: string; source: string; input_tokens: number }[];
      by_machine_source: { machine_id: string; source: string; input_tokens: number }[];
      by_day_model: { day: string; model: string; input_tokens: number }[];
    };
    expect(body.tools).toEqual(["claude", "codex"]);
    // In the order the dashboard first saw them (opus and haiku came in the first summary test).
    expect(body.models).toEqual(["opus", "haiku", "gpt-5.5"]);
    expect(
      Object.fromEntries(body.by_day_source.map((r) => [`${r.day} ${r.source}`, r.input_tokens])),
    ).toEqual({ "2026-08-01 claude": 10, "2026-08-01 codex": 3, "2026-08-02 codex": 3 });
    expect(
      Object.fromEntries(
        body.by_machine_source.map((r) => [`${r.machine_id} ${r.source}`, r.input_tokens]),
      ),
    ).toEqual({ [`${a.id} claude`]: 10, [`${a.id} codex`]: 5, [`${b.id} codex`]: 1 });
    // A model used by several tools is one model.
    expect(body.by_day_model.find((r) => r.day === "2026-08-02")?.input_tokens).toBe(3);

    const machines = (await (await w.fetch("/api/machines", { cookie: viewer.cookie })).json()) as {
      machines: { id: string; tools: string[] }[];
    };
    const tools = Object.fromEntries(machines.machines.map((m) => [m.id, m.tools]));
    expect(tools[a.id]).toEqual(["claude", "codex"]);
    expect(tools[b.id]).toEqual(["codex"]);
  });

  test("detail=1 answers with the rows, for totaling and filtering in the browser", async () => {
    // The rows uploaded by the previous test.
    const res = await w.fetch("/api/summary?from=2026-08-01&to=2026-08-02&detail=1", {
      cookie: viewer.cookie,
    });
    const body = (await res.json()) as Detailed;
    expect(body.bucket).toBe("day");
    // The browser works out the totals from the rows.
    expect(body).not.toHaveProperty("by_day_machine");
    const readable = readRows(body);
    const machines = body.detail.machines;
    const [a, b] = machines.length === 2 ? machines : ["", ""];
    expect(new Set(machines).size).toBe(2);
    expect(readable).toEqual(
      [
        `2026-08-01 ${a} claude opus 10`,
        `2026-08-01 ${a} codex gpt-5.5 3`,
        `2026-08-02 ${a} codex gpt-5.5 2`,
        `2026-08-02 ${b} codex gpt-5.5 1`,
      ].sort(),
    );
    expect(body.detail.rows[0]).toHaveLength(9);
    // Without detail, the totals; and the two answers aren't confused by caching.
    const plain = await w.fetch("/api/summary?from=2026-08-01&to=2026-08-02", {
      cookie: viewer.cookie,
    });
    const plainBody = await plain.json();
    expect(plainBody).not.toHaveProperty("detail");
    expect(plainBody).toHaveProperty("by_day_machine");
    expect(plain.headers.get("etag")).not.toBe(res.headers.get("etag"));
  });

  describe("long periods", () => {
    // Usage in 2023 and 2024, before anything else these tests upload.
    let id = "";
    beforeAll(async () => {
      id = (await w.createMachine({ name: "long-ago" })).id;
      for (const [day, n] of [
        ["2023-01-04", 1], // a Wednesday
        ["2023-01-08", 2], // the Sunday of that week
        ["2023-01-09", 4], // the next Monday
        ["2023-02-20", 8],
        ["2024-06-30", 16],
      ] as const) {
        await w.sql(
          `INSERT INTO usage_daily (machine_id, source, day, model, input_tokens, output_tokens,
             cache_creation_tokens, cache_read_tokens, cost_usd, updated_at)
           VALUES (?1, 'claude', ?2, 'opus', ?3, 0, 0, 0, ?4, 0)`,
          id,
          day,
          n,
          n / 10,
        );
      }
    });
    const detailed = async (query: string) =>
      (await (
        await w.fetch(`/api/summary?${query}&detail=1`, { cookie: viewer.cookie })
      ).json()) as Detailed;

    test("up to 92 days, rows per day", async () => {
      const body = await detailed("from=2023-01-01&to=2023-04-02");
      expect(body.bucket).toBe("day");
      expect(readRows(body)).toEqual([
        `2023-01-04 ${id} claude opus 1`,
        `2023-01-08 ${id} claude opus 2`,
        `2023-01-09 ${id} claude opus 4`,
        `2023-02-20 ${id} claude opus 8`,
      ]);
    });

    test("over 92 days, rows per week, from Monday", async () => {
      const body = await detailed("from=2023-01-01&to=2023-04-03");
      expect(body.bucket).toBe("week");
      expect(readRows(body)).toEqual([
        `2023-01-02 ${id} claude opus 3`,
        `2023-01-09 ${id} claude opus 4`,
        `2023-02-20 ${id} claude opus 8`,
      ]);
      const cost = body.detail.rows.find((r) => body.detail.days[r[0]] === "2023-01-02")?.[8];
      expect(cost).toBeCloseTo(0.3);
    });

    test("over two years, rows per month", async () => {
      const body = await detailed("from=2023-01-01&to=2025-01-31");
      expect(body.bucket).toBe("month");
      expect(readRows(body)).toEqual([
        `2023-01-01 ${id} claude opus 7`,
        `2023-02-01 ${id} claude opus 8`,
        `2024-06-01 ${id} claude opus 16`,
      ]);
    });

    test("without detail, totals stay per day", async () => {
      const res = await w.fetch("/api/summary?from=2023-01-01&to=2023-06-30", {
        cookie: viewer.cookie,
      });
      const body = (await res.json()) as { by_day_machine: { day: string }[] };
      expect(body.by_day_machine.map((r) => r.day)).toEqual([
        "2023-01-04",
        "2023-01-08",
        "2023-01-09",
        "2023-02-20",
      ]);
    });

    test("all=1 starts at the first day with usage", async () => {
      const res = await w.fetch("/api/summary?all=1&detail=1", { cookie: viewer.cookie });
      const body = (await res.json()) as Detailed & { from: string; to: string; today: string };
      expect(body.from).toBe("2023-01-04");
      expect(body.to).toBe(body.today);
      expect(body.bucket).toBe("month");
      expect(body.detail.days).toContain("2023-01-01");
      const tenYears = await w.fetch("/api/summary?days=3660&detail=1", { cookie: viewer.cookie });
      expect(tenYears.headers.get("etag")).not.toBe(res.headers.get("etag"));
      expect(((await tenYears.json()) as { from: string }).from).not.toBe("2023-01-04");
    });
  });

  test("defaults to the last 30 days in the dashboard's time zone", async () => {
    const res = await w.fetch("/api/summary", { cookie: viewer.cookie });
    const body = (await res.json()) as {
      from: string;
      to: string;
      today: string;
      timezone: string;
    };
    expect(body.to).toBe(body.today);
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(29);
    expect(body.timezone).toBe("UTC");
  });

  test("days=N means the last N days ending today", async () => {
    const res = await w.fetch("/api/summary?days=7", { cookie: viewer.cookie });
    const body = (await res.json()) as { from: string; to: string; today: string };
    expect(body.to).toBe(body.today);
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(6);
  });

  test.each([
    ["days=0", 400],
    ["days=abc", 400],
    ["from=2026-10-10&to=2026-10-01", 400],
    ["from=yesterday", 400],
    ["from=2000-01-01&to=2026-01-01", 400],
  ])("rejects %s", async (query, status) => {
    expect((await w.fetch(`/api/summary?${query}`, { cookie: viewer.cookie })).status).toBe(status);
  });
});

describe("machines", () => {
  test("lists machines with a status", async () => {
    const fresh = await w.createMachine({ name: "list-fresh" });
    const late = await w.createMachine({ name: "list-late" });
    await w.sql("UPDATE machines SET last_seen_at = ?1 WHERE id = ?2", Date.now(), fresh.id);
    await w.sql(
      "UPDATE machines SET last_seen_at = ?1 WHERE id = ?2",
      Date.now() - 3 * 3_600_000,
      late.id,
    );
    const res = await w.fetch("/api/machines", { cookie: viewer.cookie });
    const body = (await res.json()) as { machines: { id: string; status: string }[] };
    const status = Object.fromEntries(body.machines.map((m) => [m.id, m.status]));
    expect(status[fresh.id]).toBe("ok");
    expect(status[late.id]).toBe("late");
  });

  test("admins can rename, names must be unique, and unknown ids are 404", async () => {
    const m = await w.createMachine({ name: "rename-me" });
    await w.createMachine({ name: "taken-name" });
    const rename = (id: string, name: string) =>
      w.fetch(`/api/machines/${id}`, { ...jsonInit("PATCH", { name }), cookie: admin.cookie });
    expect((await rename(m.id, "  Office PC  ")).status).toBe(200);
    expect((await w.sql("SELECT name FROM machines WHERE id = ?1", m.id))[0]?.name).toBe(
      "Office PC",
    );
    expect((await rename(m.id, "TAKEN-name")).status).toBe(409);
    expect((await rename(m.id, "")).status).toBe(400);
    expect((await rename(m.id, "bad\u0007name")).status).toBe(400);
    expect((await rename("no-such-id", "whatever")).status).toBe(404);
  });

  test("revoking keeps the history but stops uploads", async () => {
    const m = await w.createMachine();
    const up = () =>
      w.fetch(
        "/agent/ingest",
        jsonInit("POST", payload(), { headers: { authorization: `Bearer ${m.token}` } }),
      );
    expect((await up()).status).toBe(200);
    const res = await w.fetch(`/api/machines/${m.id}`, { method: "DELETE", cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await w.sql("SELECT 1 FROM usage_daily WHERE machine_id = ?1", m.id)).toHaveLength(1);
    await w.sql("UPDATE machines SET last_seen_at = 0 WHERE id = ?1", m.id);
    expect((await up()).status).toBe(401);
    expect(
      (await w.fetch(`/api/machines/${m.id}`, { method: "DELETE", cookie: admin.cookie })).status,
    ).toBe(404);
  });
});

describe("usage days", () => {
  test("lists the days with any usage, and supports ETags", async () => {
    const m = await w.createMachine({ name: "days" });
    await w.fetch(
      "/agent/ingest",
      jsonInit(
        "POST",
        payload({
          range: { from: "2025-03-01", to: "2025-03-05" },
          days: [
            { date: "2025-03-01", source: "claude", models: [model("opus", 3, 0.3)] },
            { date: "2025-03-02", source: "claude", models: [model("opus", 0, 0)] },
            { date: "2025-03-04", source: "claude", models: [model("haiku", 1, 0.01)] },
          ],
        }),
        { headers: { authorization: `Bearer ${m.token}` } },
      ),
    );
    const res = await w.fetch("/api/usage-days?from=2025-03-01&to=2025-03-31", {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(200);
    // A day whose rows are all zero doesn't count.
    expect(await res.json()).toEqual({ days: ["2025-03-01", "2025-03-04"] });

    const again = await w.fetch("/api/usage-days?from=2025-03-01&to=2025-03-31", {
      cookie: viewer.cookie,
      headers: { "if-none-match": res.headers.get("etag") ?? "" },
    });
    expect(again.status).toBe(304);
  });

  test("can be limited to machines, tools and models", async () => {
    const a = await w.createMachine({ name: "days-a" });
    const b = await w.createMachine({ name: "days-b" });
    const up = (token: string, days: unknown[]) =>
      w.fetch(
        "/agent/ingest",
        jsonInit(
          "POST",
          payload({
            schema_version: 2,
            sources: ["claude", "kimi"],
            range: { from: "2024-05-01", to: "2024-05-05" },
            days,
          }),
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );
    await up(a.token, [
      { date: "2024-05-01", source: "claude", models: [model("claude-opus-5-5", 1, 0.1)] },
      { date: "2024-05-02", source: "kimi", models: [model("k3", 1, 0.1)] },
    ]);
    await up(b.token, [
      { date: "2024-05-03", source: "kimi", models: [model("k3", 1, 0.1)] },
      { date: "2024-05-04", source: "claude", models: [model("claude-mythos-5-1", 1, 0.1)] },
    ]);
    const days = async (filters: string) =>
      (
        (await (
          await w.fetch(`/api/usage-days?from=2024-05-01&to=2024-05-31${filters}`, {
            cookie: viewer.cookie,
          })
        ).json()) as { days: string[] }
      ).days;
    expect(await days("")).toEqual(["2024-05-01", "2024-05-02", "2024-05-03", "2024-05-04"]);
    expect(await days(`&machine=${a.id}`)).toEqual(["2024-05-01", "2024-05-02"]);
    expect(await days("&source=kimi")).toEqual(["2024-05-02", "2024-05-03"]);
    expect(await days(`&source=kimi&machine=${b.id}`)).toEqual(["2024-05-03"]);
    expect(await days("&model=claude-opus-5-5&model=claude-mythos-5-1")).toEqual([
      "2024-05-01",
      "2024-05-04",
    ]);
    // Different filters are cached separately.
    const all = await w.fetch("/api/usage-days?from=2024-05-01&to=2024-05-31", {
      cookie: viewer.cookie,
    });
    const kimi = await w.fetch("/api/usage-days?from=2024-05-01&to=2024-05-31&source=kimi", {
      cookie: viewer.cookie,
      headers: { "if-none-match": all.headers.get("etag") ?? "" },
    });
    expect(kimi.status).toBe(200);
    const tooMany = Array.from({ length: 501 }, (_, i) => `model=m${i}`).join("&");
    expect(
      (
        await w.fetch(`/api/usage-days?from=2024-05-01&to=2024-05-31&${tooMany}`, {
          cookie: viewer.cookie,
        })
      ).status,
    ).toBe(400);
  });

  test.each([
    ["", "missing dates"],
    ["?from=2025-03-01", "missing end"],
    ["?from=2025-03-31&to=2025-03-01", "reversed"],
    ["?from=2000-01-01&to=2025-01-01", "longer than ten years"],
    ["?from=2025-3-1&to=2025-03-31", "not YYYY-MM-DD"],
  ])("rejects %s (%s)", async (query) => {
    const res = await w.fetch(`/api/usage-days${query}`, { cookie: viewer.cookie });
    expect(res.status).toBe(400);
  });

  test("needs a login", async () => {
    expect((await w.fetch("/api/usage-days?from=2025-03-01&to=2025-03-31")).status).toBe(401);
  });
});

describe("settings", () => {
  test("viewers can read settings", async () => {
    const res = await w.fetch("/api/settings", { cookie: viewer.cookie });
    expect(await res.json()).toMatchObject({
      timezone: "UTC",
      server_version: "test",
      source_repo: "IAmForeverAloneToo/ccunified-dashboard",
    });
  });

  test("admins can change the time zone; machines must then re-upload", async () => {
    const set = (timezone: string) =>
      w.fetch("/api/settings", { ...jsonInit("PATCH", { timezone }), cookie: admin.cookie });
    expect((await set("Mars/Base")).status).toBe(400);
    expect((await set("America/Toronto")).status).toBe(200);
    const m = await w.createMachine();
    const res = await w.fetch(
      "/agent/ingest",
      jsonInit("POST", payload(), { headers: { authorization: `Bearer ${m.token}` } }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "timezone_mismatch", timezone: "America/Toronto" });
    expect((await set("UTC")).status).toBe(200);
  });
});
