import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, newLoginKey, startWorker, type TestUser, type TestWorker } from "./harness";

let w: TestWorker;
let admin: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  w = await startWorker();
  admin = await w.createUser({ role: "admin", username: "root-admin" });
  viewer = await w.createUser({ role: "viewer", username: "just-viewing" });
});
afterAll(() => w.dispose());

const as = (u: TestUser, path: string, init: RequestInit = {}) =>
  w.fetch(path, { ...init, cookie: u.cookie });

async function userRow(id: string) {
  const [row] = await w.sql(
    "SELECT role, disabled_at, must_change_password, totp_enabled FROM users WHERE id = ?1",
    id,
  );
  return row;
}

describe("user management", () => {
  test("only admins can see or manage users", async () => {
    expect((await as(viewer, "/api/users")).status).toBe(403);
    expect(
      (
        await as(
          viewer,
          "/api/users",
          jsonInit("POST", { username: "x-y-z", role: "viewer", key: newLoginKey() }),
        )
      ).status,
    ).toBe(403);
    expect((await as(admin, "/api/users")).status).toBe(200);
  });

  test("creating a user: they log in with the admin-set password and must change it", async () => {
    const key = newLoginKey();
    const res = await as(
      admin,
      "/api/users",
      jsonInit("POST", { username: "new.person", role: "viewer", key }),
    );
    expect(res.status).toBe(201);
    const login = await w.login("new.person", key);
    expect(await login.json()).toMatchObject({
      user: { role: "viewer", must_change_password: true },
    });

    const list = (await (await as(admin, "/api/users")).json()) as {
      users: { username: string; password_hash?: string }[];
    };
    expect(list.users.map((u) => u.username)).toContain("new.person");
    expect(JSON.stringify(list)).not.toContain("password_hash");
    expect(JSON.stringify(list)).not.toContain("totp_secret");
  });

  test.each([
    [{ username: "ab", role: "viewer" }, 400],
    [{ username: "has space", role: "viewer" }, 400],
    [{ username: "fine-name", role: "owner" }, 400],
    [{ username: "ROOT-ADMIN", role: "viewer" }, 409],
  ])("rejects %o", async (body, status) => {
    expect(
      (await as(admin, "/api/users", jsonInit("POST", { ...body, key: newLoginKey() }))).status,
    ).toBe(status);
  });

  test("changing role, disabling and resetting a password end that user's sessions", async () => {
    const u = await w.createUser({ role: "viewer" });
    const patch = (body: unknown) => as(admin, `/api/users/${u.id}`, jsonInit("PATCH", body));

    expect((await patch({ role: "admin" })).status).toBe(200);
    expect(await userRow(u.id)).toMatchObject({ role: "admin" });
    expect((await w.fetch("/api/me", { cookie: u.cookie })).status).toBe(401);

    const key = newLoginKey();
    expect((await patch({ key })).status).toBe(200);
    expect(await userRow(u.id)).toMatchObject({ must_change_password: 1 });
    expect((await w.login(u.username, u.key)).status).toBe(401);
    expect((await w.login(u.username, key)).status).toBe(200);

    expect((await patch({ disabled: true })).status).toBe(200);
    expect((await w.login(u.username, key)).status).toBe(401);
    expect((await patch({ disabled: false })).status).toBe(200);
    expect((await w.login(u.username, key)).status).toBe(200);
  });

  test("an admin can switch off two-factor for someone who lost their phone", async () => {
    const u = await w.createUser({ role: "viewer" });
    await w.sql("UPDATE users SET totp_enabled = 1, totp_secret = 'AAAA' WHERE id = ?1", u.id);
    expect(
      (await as(admin, `/api/users/${u.id}`, jsonInit("PATCH", { reset_2fa: true }))).status,
    ).toBe(200);
    expect(await userRow(u.id)).toMatchObject({ totp_enabled: 0 });
    expect((await w.login(u.username, u.key)).status).toBe(200);
  });

  test("admins cannot lock themselves out", async () => {
    for (const body of [{ role: "viewer" }, { disabled: true }, { key: newLoginKey() }]) {
      const res = await as(admin, `/api/users/${admin.id}`, jsonInit("PATCH", body));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "cannot_change_self" });
    }
    expect((await as(admin, `/api/users/${admin.id}`, { method: "DELETE" })).status).toBe(409);
  });

  test("deleting a user", async () => {
    const u = await w.createUser({ role: "viewer" });
    expect((await as(admin, `/api/users/${u.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await w.fetch("/api/me", { cookie: u.cookie })).status).toBe(401);
    expect((await as(admin, `/api/users/${u.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("an empty change is refused", async () => {
    expect((await as(admin, `/api/users/${viewer.id}`, jsonInit("PATCH", {}))).status).toBe(400);
  });
});
