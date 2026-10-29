import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, newLoginKey, startWorker, type TestWorker } from "./harness";

let w: TestWorker;

beforeAll(async () => {
  w = await startWorker();
});
afterAll(() => w.dispose());

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = /__Host-ccu_session=([^;]+)/.exec(header);
  if (!match) throw new Error(`no session cookie in: ${header}`);
  return `__Host-ccu_session=${match[1]}`;
}

describe("login parameters", () => {
  test("are public and include this install's salt id", async () => {
    const res = await w.fetch("/api/login-params");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kdf: "PBKDF2-SHA256", iterations: 600_000, version: "v1" });
    expect(body.install_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("login", () => {
  test("a correct login sets a strict, secure, HTTP-only session cookie", async () => {
    const u = await w.createUser({ role: "viewer" });
    const res = await w.login(u.username, u.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      user: { username: u.username, role: "viewer" },
    });
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    const me = await w.fetch("/api/me", { cookie: sessionCookie(res) });
    expect(me.status).toBe(200);
  });

  test("usernames are not case-sensitive", async () => {
    const u = await w.createUser({ username: "CaseTester" });
    expect((await w.login("casetester", u.key)).status).toBe(200);
  });

  test("a wrong password and an unknown user get the same answer", async () => {
    const u = await w.createUser();
    const wrong = await w.login(u.username, newLoginKey());
    const unknown = await w.login("nobody-here", newLoginKey());
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
    expect(await unknown.json()).toEqual({ error: "invalid_credentials" });
  });

  test("malformed login keys are rejected before any checking", async () => {
    const res = await w.fetch(
      "/api/login",
      jsonInit("POST", { username: "a", key: "password123" }),
    );
    expect(res.status).toBe(400);
  });

  test("disabled users cannot log in", async () => {
    const u = await w.createUser();
    await w.sql("UPDATE users SET disabled_at = 1 WHERE id = ?1", u.id);
    expect((await w.login(u.username, u.key)).status).toBe(401);
  });

  test("login requests from another site are refused", async () => {
    const u = await w.createUser();
    const res = await w.fetch(
      "/api/login",
      jsonInit(
        "POST",
        { username: u.username, key: u.key },
        { headers: { origin: "https://evil.example" } },
      ),
    );
    expect(res.status).toBe(403);
  });

  test("10 wrong passwords lock the account for 15 minutes, even for the right password", async () => {
    const u = await w.createUser();
    for (let i = 0; i < 10; i++) {
      expect((await w.login(u.username, newLoginKey())).status).toBe(401);
    }
    const locked = await w.login(u.username, u.key);
    expect(locked.status).toBe(429);
    const wait = Number(locked.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    // Other accounts are unaffected.
    const other = await w.createUser();
    expect((await w.login(other.username, other.key)).status).toBe(200);
  });

  test("a successful login resets the failure count", async () => {
    const u = await w.createUser();
    for (let i = 0; i < 9; i++) await w.login(u.username, newLoginKey());
    expect((await w.login(u.username, u.key)).status).toBe(200);
    for (let i = 0; i < 9; i++) await w.login(u.username, newLoginKey());
    expect((await w.login(u.username, u.key)).status).toBe(200);
  });

  test("wrong passwords sent all at once are counted before they're checked", async () => {
    const u = await w.createUser();
    const ip = { "cf-connecting-ip": "198.51.100.30" };
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        w.fetch(
          "/api/login",
          jsonInit("POST", { username: u.username, key: newLoginKey() }, { headers: ip }),
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    // Only the account's limit of 10 were checked; the rest were refused.
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    expect((await w.login(u.username, u.key)).status).toBe(429);
  });

  test("the same goes for one address trying many accounts at once", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.31" };
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        w.fetch(
          "/api/login",
          jsonInit("POST", { username: `burst-${i}`, key: newLoginKey() }, { headers: ip }),
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(50);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });

  test("successful logins don't count against the address", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.32" };
    const u = await w.createUser();
    for (let i = 0; i < 55; i++) {
      const res = await w.fetch(
        "/api/login",
        jsonInit("POST", { username: u.username, key: u.key }, { headers: ip }),
      );
      expect(res.status).toBe(200);
    }
  });

  test("50 failures from one address block that address", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.77" };
    for (let i = 0; i < 50; i++) {
      await w.fetch(
        "/api/login",
        jsonInit("POST", { username: `spray-${i}`, key: newLoginKey() }, { headers: ip }),
      );
    }
    const u = await w.createUser();
    const res = await w.fetch(
      "/api/login",
      jsonInit("POST", { username: u.username, key: u.key }, { headers: ip }),
    );
    expect(res.status).toBe(429);
  });
});

describe("logout", () => {
  test("ends the session", async () => {
    const u = await w.createUser();
    const cookie = sessionCookie(await w.login(u.username, u.key));
    expect((await w.fetch("/api/logout", { method: "POST", cookie })).status).toBe(200);
    expect((await w.fetch("/api/me", { cookie })).status).toBe(401);
  });
});

describe("changing your password", () => {
  test("requires the current password and signs out other sessions", async () => {
    const u = await w.createUser();
    const a = sessionCookie(await w.login(u.username, u.key));
    const b = sessionCookie(await w.login(u.username, u.key));
    const newKey = newLoginKey();

    const wrong = await w.fetch("/api/me/password", {
      ...jsonInit("POST", { current_key: newLoginKey(), new_key: newKey }),
      cookie: a,
    });
    expect(wrong.status).toBe(401);

    const same = await w.fetch("/api/me/password", {
      ...jsonInit("POST", { current_key: u.key, new_key: u.key }),
      cookie: a,
    });
    expect(same.status).toBe(400);

    const ok = await w.fetch("/api/me/password", {
      ...jsonInit("POST", { current_key: u.key, new_key: newKey }),
      cookie: a,
    });
    expect(ok.status).toBe(200);
    expect((await w.fetch("/api/me", { cookie: a })).status).toBe(200);
    expect((await w.fetch("/api/me", { cookie: b })).status).toBe(401);
    expect((await w.login(u.username, u.key)).status).toBe(401);
    expect((await w.login(u.username, newKey)).status).toBe(200);
  });

  test("a password set by an admin must be changed before anything else", async () => {
    const u = await w.createUser({ role: "admin", mustChangePassword: true });
    const login = await w.login(u.username, u.key);
    expect(await login.json()).toMatchObject({ user: { must_change_password: true } });
    const cookie = sessionCookie(login);

    expect(await (await w.fetch("/api/me", { cookie })).json()).toMatchObject({
      must_change_password: true,
    });
    const blocked = await w.fetch("/api/summary", { cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "password_change_required" });

    await w.fetch("/api/me/password", {
      ...jsonInit("POST", { current_key: u.key, new_key: newLoginKey() }),
      cookie,
    });
    expect((await w.fetch("/api/summary", { cookie })).status).toBe(200);
  });
});
