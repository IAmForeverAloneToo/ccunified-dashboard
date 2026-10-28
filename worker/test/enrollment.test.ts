// Adding many machines with a script: enrollment keys, machines enrolling
// with them, and approving those machines from the list.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, startWorker, type TestUser, type TestWorker } from "./harness";

let w: TestWorker;
let admin: TestUser;
let manager: TestUser;
let otherManager: TestUser;
let member: TestUser;
let viewer: TestUser;
let eng: string;
let design: string;

const send = (who: TestUser, method: string, path: string, body?: unknown) =>
  method === "GET"
    ? w.fetch(path, { cookie: who.cookie })
    : w.fetch(path, { ...jsonInit(method, body ?? {}), cookie: who.cookie });

async function createKey(who: TestUser, body: Record<string, unknown>) {
  return send(who, "POST", "/api/enrollment-keys", {
    name: "Laptops",
    department_id: null,
    owner_id: null,
    expires_in_days: null,
    max_uses: null,
    ...body,
  });
}

async function newKey(who: TestUser, body: Record<string, unknown> = {}) {
  const res = await createKey(who, body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

function enroll(key: string, name: string, ip = "198.51.100.7") {
  return w.fetch(
    "/agent/enroll",
    jsonInit(
      "POST",
      {
        enroll_key: key,
        machine_name: name,
        os: "linux",
        arch: "amd64",
        agent_version: "0.7.0",
        sync_interval_minutes: 30,
      },
      { headers: { "cf-connecting-ip": ip } },
    ),
  );
}

async function enrolled(key: string, name: string) {
  const res = await enroll(key, name);
  expect(res.status).toBe(200);
  return (await res.json()) as { device_code: string; machine_name: string; expires_in: number };
}

const poll = async (deviceCode: string) =>
  (await (
    await w.fetch("/agent/pair/poll", jsonInit("POST", { device_code: deviceCode }))
  ).json()) as { status: string; token?: string; machine?: { id: string; name: string } };

interface Waiting {
  id: string;
  machine_name: string;
  department: { id: string } | null;
  owner: { username: string } | null;
  key: { name: string } | null;
}
async function waitingFor(who: TestUser): Promise<Waiting[]> {
  const res = await send(who, "GET", "/api/pairing");
  return ((await res.json()) as { requests: Waiting[] }).requests;
}
const idOf = async (name: string) =>
  (await waitingFor(admin)).find((r) => r.machine_name === name)?.id ?? "";

beforeAll(async () => {
  w = await startWorker();
  eng = await w.createDepartment("Engineering");
  design = await w.createDepartment("Design");
  admin = await w.createUser({ role: "admin", username: "admin" });
  viewer = await w.createUser({ role: "viewer", username: "viewer" });
  manager = await w.createUser({ role: null, departments: [{ id: eng, role: "manager" }] });
  otherManager = await w.createUser({
    role: null,
    departments: [{ id: design, role: "manager" }],
  });
  member = await w.createUser({
    role: null,
    username: "riley",
    departments: [{ id: eng, role: "member" }],
  });
});
afterAll(() => w.dispose());

describe("enrollment keys", () => {
  test("admins and managers create them; a key is shown once and stored only as a hash", async () => {
    const { id, key } = await newKey(admin);
    expect(key).toMatch(/^ccu_e_[A-Za-z0-9_-]{40,}$/);
    const [row] = await w.sql("SELECT key_hash FROM enrollment_keys WHERE id = ?1", id);
    expect(row?.key_hash).not.toContain(key);
    const res = await send(admin, "GET", "/api/enrollment-keys");
    expect(JSON.stringify(await res.json())).not.toContain(key);
  });

  test("managers only for their departments; others not at all", async () => {
    expect((await createKey(manager, { department_id: null })).status).toBe(403);
    expect((await createKey(manager, { department_id: design })).status).toBe(403);
    expect((await createKey(manager, { department_id: eng })).status).toBe(201);
    expect((await createKey(member, { department_id: eng })).status).toBe(403);
    expect((await createKey(viewer, {})).status).toBe(403);
    expect((await send(viewer, "GET", "/api/enrollment-keys")).status).toBe(403);
    // The owner must be able to own machines in the department.
    expect((await createKey(admin, { department_id: design, owner_id: member.id })).status).toBe(
      409,
    );
    expect((await createKey(admin, { name: "" })).status).toBe(400);
    expect((await createKey(admin, { max_uses: 0 })).status).toBe(400);
  });

  test("managers see their departments' keys; admins see them all", async () => {
    await newKey(otherManager, { name: "Design laptops", department_id: design });
    const names = async (who: TestUser) =>
      (
        (await (await send(who, "GET", "/api/enrollment-keys")).json()) as {
          keys: { name: string; department: { id: string } | null }[];
        }
      ).keys;
    expect((await names(manager)).every((k) => k.department?.id === eng)).toBe(true);
    expect((await names(admin)).some((k) => k.name === "Design laptops")).toBe(true);
  });
});

describe("enrolling", () => {
  test("a machine waits on the Approvals page, in the key's department, with its owner", async () => {
    const { key } = await newKey(manager, {
      name: "Eng laptops",
      department_id: eng,
      owner_id: member.id,
    });
    const req = await enrolled(key, "eng-laptop");
    expect(req.machine_name).toBe("eng-laptop");
    expect(req.expires_in).toBe(30 * 24 * 60 * 60);
    expect((await poll(req.device_code)).status).toBe("pending");
    const seen = (await waitingFor(manager)).find((r) => r.machine_name === "eng-laptop");
    expect(seen?.department?.id).toBe(eng);
    expect(seen?.owner?.username).toBe("riley");
    expect(seen?.key?.name).toBe("Eng laptops");
    // Not for another department's manager.
    expect((await waitingFor(otherManager)).some((r) => r.machine_name === "eng-laptop")).toBe(
      false,
    );
  });

  test("a name in use gets a number", async () => {
    const { key } = await newKey(admin);
    await w.createMachine({ name: "build-box" });
    expect((await enrolled(key, "build-box")).machine_name).toBe("build-box-2");
    expect((await enrolled(key, "build-box")).machine_name).toBe("build-box-3");
  });

  test("wrong, revoked, expired and used-up keys are refused", async () => {
    expect((await enroll("ccu_e_wrong", "x")).status).toBe(401);
    const once = await newKey(admin, { max_uses: 1 });
    await enrolled(once.key, "only-one");
    expect(await (await enroll(once.key, "second")).json()).toEqual({
      error: "enroll_key_used_up",
    });
    const old = await newKey(admin, { expires_in_days: 1 });
    await w.sql("UPDATE enrollment_keys SET expires_at = ?1 WHERE id = ?2", Date.now() - 1, old.id);
    expect(await (await enroll(old.key, "late")).json()).toEqual({ error: "enroll_key_expired" });
  });

  test("a key can be checked without using it", async () => {
    const { id, key } = await newKey(admin, { max_uses: 1 });
    const check = (k: string) =>
      w.fetch("/agent/enroll/check", jsonInit("POST", { enroll_key: k }));
    expect((await check(key)).status).toBe(200);
    expect((await check(key)).status).toBe(200);
    const [row] = await w.sql("SELECT uses FROM enrollment_keys WHERE id = ?1", id);
    expect(row?.uses).toBe(0);
    expect(await (await check("ccu_e_nope")).json()).toEqual({ error: "invalid_enroll_key" });
  });

  test("guessing keys is slowed down", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await enroll(`ccu_e_guess${i}`, "x", "203.0.113.50")).status).toBe(401);
    }
    expect((await enroll("ccu_e_guess", "x", "203.0.113.50")).status).toBe(429);
  });
});

describe("approving enrolled machines", () => {
  test("many at once; each gets its upload key, department and owner", async () => {
    const { key } = await newKey(admin, { department_id: eng, owner_id: member.id });
    const a = await enrolled(key, "fleet-a");
    const b = await enrolled(key, "fleet-b");
    const res = await send(manager, "POST", "/api/pairing/decide", {
      ids: [await idOf("fleet-a"), await idOf("fleet-b")],
      approve: true,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { decided: number }).decided).toBe(2);
    for (const d of [a, b]) {
      const p = await poll(d.device_code);
      expect(p.status).toBe("approved");
      expect(p.token).toMatch(/^ccu_m_/);
      const [m] = await w.sql(
        "SELECT department_id, owner_id FROM machines WHERE id = ?1",
        p.machine?.id,
      );
      expect(m).toEqual({ department_id: eng, owner_id: member.id });
    }
  });

  test("a name taken while it waited gets a number when approved", async () => {
    const { key } = await newKey(admin);
    const req = await enrolled(key, "renamed-later");
    const id = await idOf("renamed-later");
    await w.createMachine({ name: "renamed-later" });
    const res = await send(admin, "POST", "/api/pairing/decide", { ids: [id], approve: true });
    expect(((await res.json()) as { names: Record<string, string> }).names[id]).toBe(
      "renamed-later-2",
    );
    expect((await poll(req.device_code)).machine?.name).toBe("renamed-later-2");
  });

  test("denying, and who may decide", async () => {
    const { key } = await newKey(admin, { department_id: eng });
    const req = await enrolled(key, "deny-me");
    const id = await idOf("deny-me");
    expect(
      (await send(otherManager, "POST", "/api/pairing/decide", { ids: [id], approve: true }))
        .status,
    ).toBe(404);
    expect(
      (await send(viewer, "POST", "/api/pairing/decide", { ids: [id], approve: true })).status,
    ).toBe(403);
    expect(
      (await send(manager, "POST", "/api/pairing/decide", { ids: [id], approve: false })).status,
    ).toBe(200);
    expect((await poll(req.device_code)).status).toBe("denied");
  });

  test("machines that showed a code are still approved by their code", async () => {
    const start = await w.fetch(
      "/agent/pair/start",
      jsonInit("POST", {
        machine_name: "with-code",
        os: "linux",
        arch: "amd64",
        agent_version: "0.7.0",
        sync_interval_minutes: 30,
      }),
    );
    expect(start.status).toBe(200);
    const id = await idOf("with-code");
    const res = await send(admin, "POST", "/api/pairing/decide", { ids: [id], approve: true });
    expect(res.status).toBe(404);
  });

  test("revoking a key denies the machines still waiting with it", async () => {
    const { id, key } = await newKey(admin);
    const req = await enrolled(key, "orphan");
    expect((await send(admin, "DELETE", `/api/enrollment-keys/${id}`)).status).toBe(200);
    expect((await poll(req.device_code)).status).toBe("denied");
    expect(await (await enroll(key, "after")).json()).toEqual({ error: "enroll_key_revoked" });
    expect((await send(admin, "DELETE", `/api/enrollment-keys/${id}`)).status).toBe(404);
  });

  test("a request expires after 30 days", async () => {
    const { key } = await newKey(admin);
    const req = await enrolled(key, "forgotten");
    await w.sql(
      "UPDATE pairing_requests SET expires_at = ?1 WHERE machine_name = 'forgotten'",
      Date.now() - 1,
    );
    expect((await poll(req.device_code)).status).toBe("expired");
  });
});
