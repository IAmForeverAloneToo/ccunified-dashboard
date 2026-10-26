// The dashboard's own cost estimates: prices from the lists (sent by
// machines) and custom prices, in each pricing mode.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, payload, startWorker, type TestUser, type TestWorker } from "./harness";

let w: TestWorker;
let admin: TestUser;
let viewer: TestUser;
let machine: { id: string; token: string };

const DAY = "2026-06-10";
// One million of each kind of token per model, so a cost is the sum of its prices.
const tokens = (model: string, cost: number) => ({
  model,
  input_tokens: 1e6,
  output_tokens: 1e6,
  cache_creation_tokens: 1e6,
  cache_read_tokens: 1e6,
  cost_usd: cost,
});

const sendPrices = (prices: unknown, token = machine.token) =>
  w.fetch(
    "/agent/prices",
    jsonInit("POST", { prices }, { headers: { authorization: `Bearer ${token}` } }),
  );
const listPrice = (input: number, entry: string) => ({
  input,
  output: input * 5,
  cache_write: input * 1.25,
  cache_read: input / 10,
  entry,
});

/** Each model's cost on DAY, and where its price came from. */
async function costs(who = viewer) {
  const res = await w.fetch(`/api/summary?from=${DAY}&to=${DAY}`, { cookie: who.cookie });
  const body = (await res.json()) as {
    by_day_model: { model: string; cost_usd: number }[];
    pricing: { mode: string; sources: Record<string, string> };
  };
  return {
    cost: Object.fromEntries(body.by_day_model.map((r) => [r.model, r.cost_usd])),
    sources: body.pricing.sources,
    mode: body.pricing.mode,
    etag: res.headers.get("etag"),
  };
}

beforeAll(async () => {
  w = await startWorker();
  admin = await w.createUser({ role: "admin", username: "admin" });
  viewer = await w.createUser({ role: "viewer", username: "viewer" });
  machine = await w.createMachine({ name: "desk" });
  const res = await w.fetch(
    "/agent/ingest",
    jsonInit(
      "POST",
      payload({
        schema_version: 2,
        sources: ["claude", "kimi"],
        range: { from: DAY, to: DAY },
        days: [
          {
            date: DAY,
            source: "claude",
            models: [tokens("claude-opus-5-5", 100), tokens("claude-mythos-5-1", 200)],
          },
          { date: DAY, source: "kimi", models: [tokens("k3", 300)] },
        ],
      }),
      { headers: { authorization: `Bearer ${machine.token}` } },
    ),
  );
  expect(res.status).toBe(200);
});
afterAll(() => w.dispose());

describe("prices from machines", () => {
  test("a machine asks which models the dashboard has, and sends their prices", async () => {
    const ask = await sendPrices({});
    expect(await ask.json()).toEqual({
      ok: true,
      models: ["claude-opus-5-5", "claude-mythos-5-1", "k3"],
    });
    const res = await sendPrices({
      "claude-opus-5-5": {
        models_dev: listPrice(4, "anthropic/claude-opus-5-5"),
        litellm: listPrice(5, "claude-opus-5-5"),
      },
      "claude-mythos-5-1": { litellm: listPrice(10, "claude-mythos-5-1") },
      // Not a model the dashboard has seen: not kept.
      "never-used": { models_dev: listPrice(1, "x/never-used") },
    });
    expect(res.status).toBe(200);
    expect(await w.sql("SELECT model, source FROM model_prices ORDER BY model, source")).toEqual([
      { model: "claude-mythos-5-1", source: "litellm" },
      { model: "claude-opus-5-5", source: "litellm" },
      { model: "claude-opus-5-5", source: "models.dev" },
    ]);
  });

  test("needs a machine's upload key, and checks the prices", async () => {
    expect((await sendPrices({}, "ccu_m_wrong")).status).toBe(401);
    const bad = await sendPrices({ "claude-opus-5-5": { models_dev: { input: -1 } } });
    expect(bad.status).toBe(400);
  });
});

describe("pricing modes", () => {
  test("ccusage (the default): the costs the machines reported", async () => {
    const c = await costs();
    expect(c.mode).toBe("ccusage");
    expect(c.cost).toEqual({ "claude-opus-5-5": 100, "claude-mythos-5-1": 200, k3: 300 });
    expect(c.sources).toEqual({
      "claude-opus-5-5": "ccusage",
      "claude-mythos-5-1": "ccusage",
      k3: "ccusage",
    });
  });

  test("lists: models.dev, then LiteLLM, then ccusage; for all history", async () => {
    const before = await costs();
    const res = await w.fetch("/api/prices", {
      ...jsonInit("PATCH", { mode: "lists" }),
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const c = await costs();
    // input + output + cache write + cache read prices, for a million tokens each
    expect(c.cost["claude-opus-5-5"]).toBeCloseTo(4 + 20 + 5 + 0.4);
    expect(c.cost["claude-mythos-5-1"]).toBeCloseTo(10 + 50 + 12.5 + 1);
    expect(c.cost.k3).toBe(300);
    expect(c.sources).toEqual({
      "claude-opus-5-5": "models.dev",
      "claude-mythos-5-1": "litellm",
      k3: "ccusage",
    });
    // Dashboards holding the old numbers fetch them again.
    expect(c.etag).not.toBe(before.etag);
  });

  test("custom: an admin's prices first, then the lists", async () => {
    const res = await w.fetch("/api/prices", {
      ...jsonInit("PATCH", {
        mode: "custom",
        custom: { k3: { input: 3, output: 15, cache_write: 3, cache_read: 0.3 } },
      }),
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const c = await costs();
    expect(c.cost.k3).toBeCloseTo(3 + 15 + 3 + 0.3);
    expect(c.cost["claude-opus-5-5"]).toBeCloseTo(29.4);
    expect(c.sources.k3).toBe("custom");
    // Removing it falls back again.
    await w.fetch("/api/prices", {
      ...jsonInit("PATCH", { custom: { k3: null } }),
      cookie: admin.cookie,
    });
    expect((await costs()).cost.k3).toBe(300);
  });

  test("detail rows and long periods use the same prices", async () => {
    const res = await w.fetch(`/api/summary?from=2026-01-01&to=${DAY}&detail=1`, {
      cookie: viewer.cookie,
    });
    const body = (await res.json()) as {
      bucket: string;
      detail: { models: string[]; rows: number[][] };
    };
    expect(body.bucket).toBe("week");
    const opus = body.detail.models.indexOf("claude-opus-5-5");
    expect(body.detail.rows.find((r) => r[3] === opus)?.[8]).toBeCloseTo(29.4);
  });

  test("prices that didn't change don't make dashboards fetch again", async () => {
    const before = (await costs()).etag;
    await sendPrices({
      "claude-opus-5-5": { models_dev: listPrice(4, "anthropic/claude-opus-5-5") },
    });
    expect((await costs()).etag).toBe(before);
    await sendPrices({
      "claude-opus-5-5": { models_dev: listPrice(4.5, "anthropic/claude-opus-5-5") },
    });
    expect((await costs()).etag).not.toBe(before);
  });
});

describe("who sees and sets prices", () => {
  test("admins and viewers see them; only admins change them", async () => {
    const res = await w.fetch("/api/prices", { cookie: viewer.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      models: { model: string; custom: unknown; models_dev: { entry: string } | null }[];
    };
    expect(body.models.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-mythos-5-1", "k3"]);
    expect(body.models[0]?.models_dev?.entry).toBe("anthropic/claude-opus-5-5");
    const change = await w.fetch("/api/prices", {
      ...jsonInit("PATCH", { mode: "ccusage" }),
      cookie: viewer.cookie,
    });
    expect(change.status).toBe(403);
    const member = await w.createUser({ role: null });
    expect((await w.fetch("/api/prices", { cookie: member.cookie })).status).toBe(403);
    const bad = await w.fetch("/api/prices", {
      ...jsonInit("PATCH", { mode: "cheapest" }),
      cookie: admin.cookie,
    });
    expect(bad.status).toBe(400);
  });
});
