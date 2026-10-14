import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, payload, startWorker, type TestUser, type TestWorker } from "./harness";

let w: TestWorker;
let admin: TestUser;
let viewer: TestUser;
let ipCounter = 0;

beforeAll(async () => {
  w = await startWorker();
  admin = await w.createUser({ role: "admin" });
  viewer = await w.createUser({ role: "viewer" });
});
afterAll(() => w.dispose());

interface Started {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

async function start(name = "Laptop", ip = `203.0.113.${++ipCounter}`) {
  const res = await w.fetch(
    "/agent/pair/start",
    jsonInit(
      "POST",
      {
        machine_name: name,
        os: "linux",
        arch: "amd64",
        agent_version: "0.1.0",
        sync_interval_minutes: 15,
      },
      { headers: { "cf-connecting-ip": ip } },
    ),
  );
  return { res, body: res.status === 200 ? ((await res.json()) as Started) : undefined };
}

const poll = async (device_code: string) => {
  const res = await w.fetch("/agent/pair/poll", jsonInit("POST", { device_code }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const approve = (user_code: string, name?: string, who: TestUser = admin) =>
  w.fetch("/api/pairing/approve", {
    ...jsonInit("POST", name ? { user_code, name } : { user_code }),
    cookie: who.cookie,
  });

describe("pairing a new machine", () => {
  test("full flow: start, wait, approve, receive the upload key once, upload", async () => {
    const { body: started } = await start("Workstation");
    if (!started) throw new Error("start failed");
    expect(started.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.verification_url).toBe("http://localhost/approve");
    expect(started.expires_in).toBe(600);
    expect(started.interval).toBe(5);

    expect((await poll(started.device_code)).body).toEqual({ status: "pending" });

    const list = (await (await w.fetch("/api/pairing", { cookie: admin.cookie })).json()) as {
      requests: { user_code: string; machine_name: string }[];
    };
    expect(list.requests).toContainEqual(
      expect.objectContaining({ user_code: started.user_code, machine_name: "Workstation" }),
    );
    expect(JSON.stringify(list)).not.toContain(started.device_code);

    // Typed loosely by the admin.
    const res = await approve(started.user_code.toLowerCase().replace("-", " "));
    expect(res.status).toBe(200);

    const done = await poll(started.device_code);
    expect(done.body).toMatchObject({
      status: "approved",
      machine: { name: "Workstation" },
      timezone: "UTC",
    });
    const token = done.body.token as string;
    expect(token).toMatch(/^ccu_m_[A-Za-z0-9_-]{43}$/);

    expect((await poll(started.device_code)).body).toEqual({ status: "expired" });

    const up = await w.fetch(
      "/agent/ingest",
      jsonInit("POST", payload(), { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(up.status).toBe(200);
    const [machine] = await w.sql(
      "SELECT os, sync_interval_minutes FROM machines WHERE name = 'Workstation'",
    );
    expect(machine).toMatchObject({ os: "windows", sync_interval_minutes: 30 });
  });

  test("viewers cannot see or approve requests", async () => {
    const { body } = await start();
    expect((await w.fetch("/api/pairing", { cookie: viewer.cookie })).status).toBe(403);
    expect((await approve(body?.user_code ?? "", undefined, viewer)).status).toBe(403);
  });

  test("denied requests stay denied", async () => {
    const { body } = await start();
    if (!body) throw new Error("start failed");
    const res = await w.fetch("/api/pairing/deny", {
      ...jsonInit("POST", { user_code: body.user_code }),
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    expect((await poll(body.device_code)).body).toEqual({ status: "denied" });
    expect((await approve(body.user_code)).status).toBe(404);
  });

  test("requests expire after 10 minutes", async () => {
    const { body } = await start();
    if (!body) throw new Error("start failed");
    await w.sql("UPDATE pairing_requests SET expires_at = 1 WHERE user_code = ?1", body.user_code);
    expect((await poll(body.device_code)).body).toEqual({ status: "expired" });
    expect((await approve(body.user_code)).status).toBe(404);
  });

  test("a name already in use must be changed when approving", async () => {
    await w.createMachine({ name: "Duplicate" });
    const { body } = await start("duplicate");
    if (!body) throw new Error("start failed");
    const taken = await approve(body.user_code);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "name_taken", name: "duplicate" });
    expect((await approve(body.user_code, "Duplicate 2")).status).toBe(200);
    expect((await poll(body.device_code)).body).toMatchObject({ machine: { name: "Duplicate 2" } });
  });

  test("bad codes are rejected", async () => {
    expect((await approve("not-a-code")).status).toBe(400);
    expect((await approve("AAAA-AAAA")).status).toBe(404);
    expect((await poll("no-such-device-code")).status).toBe(404);
  });

  test("one address can start at most 5 requests per 10 minutes", async () => {
    const ip = "192.0.2.200";
    for (let i = 0; i < 5; i++) expect((await start(`spam-${i}`, ip)).res.status).toBe(200);
    expect((await start("spam-6", ip)).res.status).toBe(429);
  });

  test("at most 20 requests can be waiting at once", async () => {
    await w.sql("UPDATE pairing_requests SET expires_at = 1 WHERE status = 'pending'");
    for (let i = 0; i < 20; i++) expect((await start(`flood-${i}`)).res.status).toBe(200);
    const res = await start("flood-21");
    expect(res.res.status).toBe(429);
    expect(await res.res.json()).toEqual({ error: "too_many_pending" });
  });
});
