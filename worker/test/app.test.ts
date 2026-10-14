import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorker, type TestWorker } from "./harness";

let w: TestWorker;

beforeAll(async () => {
  w = await startWorker();
});
afterAll(() => w.dispose());

test("health endpoint reports the build version", async () => {
  const res = await w.fetch("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: "test" });
});

test("every response carries the security headers", async () => {
  for (const path of ["/healthz", "/", "/api/me", "/agent/nope"]) {
    const res = await w.fetch(path);
    expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security"), path).toContain("max-age=");
  }
});

test("API and agent responses are never cached", async () => {
  expect((await w.fetch("/api/me")).headers.get("cache-control")).toBe("no-store");
  expect((await w.fetch("/agent/nope")).headers.get("cache-control")).toBe("no-store");
});

test("unknown API and agent paths are JSON 404s, not the dashboard page", async () => {
  for (const path of ["/api/nope", "/agent/nope"]) {
    const res = await w.fetch(path);
    expect(res.status, path).toBe(404);
    expect(await res.json(), path).toEqual({ error: "not_found" });
  }
});

test("dashboard routes fall back to index.html", async () => {
  for (const path of ["/", "/machines", "/settings/users"]) {
    const res = await w.fetch(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type"), path).toContain("text/html");
  }
});
