import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorker } from "./harness";

let mf: Miniflare;

beforeAll(async () => {
  mf = await startWorker();
});

afterAll(async () => {
  await mf.dispose();
});

test("health endpoint reports the build version", async () => {
  const res = await mf.dispatchFetch("http://localhost/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: "test" });
});
