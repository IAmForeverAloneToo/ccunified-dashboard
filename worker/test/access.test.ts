// Who sees and manages what: every role against every endpoint.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jsonInit, newLoginKey, startWorker, type TestUser, type TestWorker } from "./harness";

let w: TestWorker;
beforeAll(async () => {
  w = await startWorker();
});
afterAll(() => w.dispose());

const DAY = "2026-07-01";

/**
 * Two departments, people in every role, and machines in each situation.
 * Names carry a random tag, so each test can build its own world.
 */
async function world() {
  const tag = randomUUID().slice(0, 6);
  const A = await w.createDepartment(`Design ${tag}`);
  const B = await w.createDepartment(`Sales ${tag}`);
  const user = (name: string, role: "admin" | "viewer" | null, departments = {}) =>
    w.createUser({
      username: `${name}-${tag}`,
      role,
      departments: Object.entries(departments).map(([id, r]) => ({
        id,
        role: r as "manager" | "viewer" | "member",
      })),
    });
  const people = {
    admin: await user("admin", "admin"),
    viewer: await user("viewer", "viewer"),
    managerA: await user("manager-a", null, { [A]: "manager" }),
    deptViewerA: await user("dept-viewer-a", null, { [A]: "viewer" }),
    memberA: await user("member-a", null, { [A]: "member" }),
    memberA2: await user("member-a2", null, { [A]: "member" }),
    managerB: await user("manager-b", null, { [B]: "manager" }),
    memberB: await user("member-b", null, { [B]: "member" }),
    // In two departments: no single manager manages them.
    both: await user("both", null, { [A]: "member", [B]: "member" }),
    // A dashboard-wide viewer who also manages A.
    viewerManagerA: await user("viewer-manager-a", "viewer", { [A]: "manager" }),
    nobody: await user("nobody", null),
  };
  const machine = async (
    name: string,
    department: string | null,
    owner: TestUser | null,
    n: number,
  ) => {
    const m = await w.createMachine({
      name: `${name}-${tag}`,
      department,
      owner: owner?.id ?? null,
    });
    await w.sql(
      `INSERT INTO usage_daily (machine_id, source, day, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd, updated_at)
       VALUES (?1, 'claude', ?2, 'opus', ?3, 0, 0, 0, 0, 0)`,
      m.id,
      DAY,
      n,
    );
    return { ...m, name: `${name}-${tag}` };
  };
  const machines = {
    a1: await machine("a1", A, people.memberA, 1), // A, owned by memberA
    a2: await machine("a2", A, null, 2), // A, shared
    b1: await machine("b1", B, people.memberB, 4), // B, owned by memberB
    loose: await machine("loose", null, null, 8), // no department
    lent: await machine("lent", null, people.memberA, 16), // no department, owned by memberA
  };
  return { tag, A, B, people, machines };
}
type World = Awaited<ReturnType<typeof world>>;
type Person = keyof World["people"];
type MachineKey = keyof World["machines"];

const get = async (path: string, who: TestUser) => w.fetch(path, { cookie: who.cookie });
const send = (method: string, path: string, who: TestUser, body?: unknown) =>
  w.fetch(path, { ...jsonInit(method, body ?? {}), cookie: who.cookie });

/** The world's machines a person sees on /api/machines, by key. */
async function machinesSeen(x: World, who: Person): Promise<MachineKey[]> {
  const res = await get("/api/machines", x.people[who]);
  expect(res.status).toBe(200);
  const ids = new Set(
    ((await res.json()) as { machines: { id: string }[] }).machines.map((m) => m.id),
  );
  return (Object.keys(x.machines) as MachineKey[]).filter((k) => ids.has(x.machines[k].id));
}

/** The world's machines in a person's /api/summary (with and without detail), by key. */
async function usageSeen(x: World, who: Person) {
  const plain = (await (await get(`/api/summary?from=${DAY}&to=${DAY}`, x.people[who])).json()) as {
    by_day_machine: { machine_id: string }[];
  };
  const detailed = (await (
    await get(`/api/summary?from=${DAY}&to=${DAY}&detail=1`, x.people[who])
  ).json()) as { detail: { machines: string[] } };
  const pick = (ids: Set<string>) =>
    (Object.keys(x.machines) as MachineKey[]).filter((k) => ids.has(x.machines[k].id));
  return {
    plain: pick(new Set(plain.by_day_machine.map((r) => r.machine_id))),
    detail: pick(new Set(detailed.detail.machines)),
  };
}

describe("who sees which machines", () => {
  const ALL: MachineKey[] = ["a1", "a2", "b1", "loose", "lent"];
  const expected: Record<Person, MachineKey[]> = {
    admin: ALL,
    viewer: ALL,
    viewerManagerA: ALL,
    managerA: ["a1", "a2"],
    deptViewerA: ["a1", "a2"],
    memberA: ["a1", "lent"], // their own, with or without a department
    memberA2: [],
    managerB: ["b1"],
    memberB: ["b1"],
    both: [],
    nobody: [],
  };
  let x: World;
  beforeAll(async () => {
    x = await world();
  });

  test.each(Object.keys(expected) as Person[])("%s", async (who) => {
    expect(await machinesSeen(x, who)).toEqual(expected[who]);
    const usage = await usageSeen(x, who);
    expect(usage.plain).toEqual(expected[who]);
    expect(usage.detail).toEqual(expected[who]);
  });

  test("the date picker's days are limited the same way", async () => {
    const days = async (who: Person, machine: MachineKey) => {
      const res = await get(
        `/api/usage-days?from=${DAY}&to=${DAY}&machine=${x.machines[machine].id}`,
        x.people[who],
      );
      return ((await res.json()) as { days: string[] }).days;
    };
    expect(await days("memberA", "a1")).toEqual([DAY]);
    expect(await days("memberA", "b1")).toEqual([]);
    expect(await days("managerB", "a2")).toEqual([]);
    expect(await days("viewer", "b1")).toEqual([DAY]);
  });

  test("machines say whether the person manages them", async () => {
    const flags = async (who: Person) =>
      Object.fromEntries(
        (
          (await (await get("/api/machines", x.people[who])).json()) as {
            machines: {
              id: string;
              can_manage: boolean;
              department: { name: string } | null;
              owner: { username: string } | null;
            }[];
          }
        ).machines
          .filter((m) => Object.values(x.machines).some((k) => k.id === m.id))
          .map((m) => [m.id, m.can_manage]),
      );
    expect(await flags("managerA")).toEqual({ [x.machines.a1.id]: true, [x.machines.a2.id]: true });
    expect(await flags("deptViewerA")).toEqual({
      [x.machines.a1.id]: false,
      [x.machines.a2.id]: false,
    });
    expect(Object.values(await flags("viewerManagerA"))).toEqual([true, true, false, false, false]);
    const list = (await (await get("/api/machines", x.people.memberA)).json()) as {
      machines: {
        id: string;
        department: { name: string } | null;
        owner: { username: string } | null;
      }[];
    };
    const a1 = list.machines.find((m) => m.id === x.machines.a1.id);
    expect(a1?.department?.name).toBe(`Design ${x.tag}`);
    expect(a1?.owner?.username).toBe(`member-a-${x.tag}`);
  });

  test("a new machine or owner changes the summary's validator", async () => {
    const path = `/api/summary?from=${DAY}&to=${DAY}&detail=1`;
    const first = await get(path, x.people.memberA2);
    const etag = first.headers.get("etag") ?? "";
    const again = await w.fetch(path, {
      cookie: x.people.memberA2.cookie,
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    await w.sql(
      "UPDATE machines SET owner_id = ?1 WHERE id = ?2",
      x.people.memberA2.id,
      x.machines.a2.id,
    );
    const after = await w.fetch(path, {
      cookie: x.people.memberA2.cookie,
      headers: { "if-none-match": etag },
    });
    expect(after.status).toBe(200);
    await w.sql("UPDATE machines SET owner_id = NULL WHERE id = ?1", x.machines.a2.id);
  });
});

describe("who manages which machines", () => {
  let x: World;
  beforeAll(async () => {
    x = await world();
  });
  const rename = (who: Person, m: MachineKey, name = `renamed-${randomUUID().slice(0, 6)}`) =>
    send("PATCH", `/api/machines/${x.machines[m].id}`, x.people[who], { name });

  test.each([
    ["admin", "loose", 200],
    ["admin", "b1", 200],
    ["managerA", "a2", 200],
    ["viewerManagerA", "a1", 200],
    ["managerA", "b1", 404], // not theirs to see
    ["managerA", "loose", 404],
    ["viewer", "a2", 403],
    ["viewerManagerA", "b1", 403],
    ["deptViewerA", "a2", 403],
    ["memberA", "a1", 403], // their own, but they don't manage it
    ["memberA", "b1", 404],
    ["nobody", "a1", 404],
  ] as [Person, MachineKey, number][])("%s renaming %s: %i", async (who, m, status) => {
    expect((await rename(who, m)).status).toBe(status);
  });

  test("managers move machines only between departments they manage", async () => {
    const move = (who: Person, m: MachineKey, department_id: string | null) =>
      send("PATCH", `/api/machines/${x.machines[m].id}`, x.people[who], { department_id });
    expect((await move("managerA", "a2", x.B)).status).toBe(403);
    expect((await move("managerA", "a2", null)).status).toBe(403);
    expect((await move("admin", "a2", null)).status).toBe(200);
    expect((await move("admin", "a2", x.A)).status).toBe(200);
    expect((await move("admin", "a2", "no-such-department")).status).toBe(400);
  });

  test("owners have a role in the machine's department; machines without one, anyone (admins)", async () => {
    const own = (who: Person, m: MachineKey, owner: Person | null) =>
      send("PATCH", `/api/machines/${x.machines[m].id}`, x.people[who], {
        owner_id: owner ? x.people[owner].id : null,
      });
    expect((await own("managerA", "a2", "memberB")).status).toBe(409);
    expect((await own("managerA", "a2", "memberA2")).status).toBe(200);
    expect((await own("managerA", "a2", "both")).status).toBe(200);
    expect((await own("managerA", "a2", null)).status).toBe(200);
    expect((await own("admin", "loose", "memberB")).status).toBe(200);
    // Moving a machine where its owner has no role needs a new owner.
    const moved = await send("PATCH", `/api/machines/${x.machines.a1.id}`, x.people.admin, {
      department_id: x.B,
    });
    expect(moved.status).toBe(409);
    expect(
      (
        await send("PATCH", `/api/machines/${x.machines.a1.id}`, x.people.admin, {
          department_id: x.B,
          owner_id: x.people.memberB.id,
        })
      ).status,
    ).toBe(200);
  });

  test("revoking follows the same rules", async () => {
    const revoke = (who: Person, m: MachineKey) =>
      send("DELETE", `/api/machines/${x.machines[m].id}`, x.people[who]);
    expect((await revoke("deptViewerA", "a2")).status).toBe(403);
    expect((await revoke("managerB", "a2")).status).toBe(404);
    expect((await revoke("managerA", "a2")).status).toBe(200);
  });
});

describe("approving machines", () => {
  let x: World;
  beforeAll(async () => {
    x = await world();
  });

  async function waiting(name: string) {
    const res = await w.fetch(
      "/agent/pair/start",
      jsonInit("POST", {
        machine_name: name,
        os: "linux",
        arch: "amd64",
        agent_version: "0.3.0",
        sync_interval_minutes: 30,
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { device_code: string; user_code: string };
  }
  const approve = (who: Person, body: Record<string, unknown>) =>
    send("POST", "/api/pairing/approve", x.people[who], body);

  test("only admins see the waiting list", async () => {
    expect((await get("/api/pairing", x.people.admin)).status).toBe(200);
    for (const who of ["managerA", "viewer", "memberA"] as Person[]) {
      expect((await get("/api/pairing", x.people[who])).status).toBe(403);
    }
  });

  test("managers approve into their departments, with an owner from there", async () => {
    const req = await waiting(`joining-${x.tag}`);
    const code = req.user_code;
    expect((await approve("memberA", { user_code: code })).status).toBe(403);
    expect((await approve("viewer", { user_code: code })).status).toBe(403);
    expect((await approve("managerA", { user_code: code })).status).toBe(403);
    expect((await approve("managerA", { user_code: code, department_id: x.B })).status).toBe(403);
    expect(
      (
        await approve("managerA", {
          user_code: code,
          department_id: x.A,
          owner_id: x.people.memberB.id,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await approve("managerA", {
          user_code: code,
          department_id: x.A,
          owner_id: x.people.memberA2.id,
        })
      ).status,
    ).toBe(200);
    const poll = await w.fetch(
      "/agent/pair/poll",
      jsonInit("POST", { device_code: req.device_code }),
    );
    expect(((await poll.json()) as { status: string }).status).toBe("approved");
    const [row] = await w.sql(
      "SELECT department_id, owner_id FROM machines WHERE name = ?1",
      `joining-${x.tag}`,
    );
    expect(row).toEqual({ department_id: x.A, owner_id: x.people.memberA2.id });
    // The owner sees it right away; the other department doesn't.
    const names = async (who: Person) =>
      (
        (await (await get("/api/machines", x.people[who])).json()) as {
          machines: { name: string }[];
        }
      ).machines.map((m) => m.name);
    expect(await names("memberA2")).toEqual([`joining-${x.tag}`]);
    expect(await names("managerB")).not.toContain(`joining-${x.tag}`);
  });

  test("admins may approve without a department", async () => {
    const req = await waiting(`loose-join-${x.tag}`);
    expect((await approve("admin", { user_code: req.user_code })).status).toBe(200);
  });

  test("managers can deny; others can't", async () => {
    const req = await waiting(`denied-${x.tag}`);
    expect(
      (await send("POST", "/api/pairing/deny", x.people.deptViewerA, { user_code: req.user_code }))
        .status,
    ).toBe(403);
    expect(
      (await send("POST", "/api/pairing/deny", x.people.managerB, { user_code: req.user_code }))
        .status,
    ).toBe(200);
  });
});

describe("who manages which users", () => {
  let x: World;
  beforeAll(async () => {
    x = await world();
  });

  test("admins and managers list users; managers only their departments' people", async () => {
    for (const who of ["viewer", "deptViewerA", "memberA", "nobody"] as Person[]) {
      expect((await get("/api/users", x.people[who])).status).toBe(403);
    }
    const res = await get("/api/users", x.people.managerA);
    expect(res.status).toBe(200);
    const users = (
      (await res.json()) as {
        users: {
          username: string;
          can_manage: boolean;
          departments: { id: string; role: string }[];
        }[];
      }
    ).users;
    const byName = Object.fromEntries(users.map((u) => [u.username.replace(`-${x.tag}`, ""), u]));
    expect(Object.keys(byName).sort()).toEqual(
      ["both", "dept-viewer-a", "manager-a", "member-a", "member-a2", "viewer-manager-a"].sort(),
    );
    expect(Object.fromEntries(Object.entries(byName).map(([n, u]) => [n, u.can_manage]))).toEqual({
      both: false, // also in Sales
      "dept-viewer-a": true,
      "manager-a": false, // themselves
      "member-a": true,
      "member-a2": true,
      "viewer-manager-a": false, // a dashboard-wide role
    });
    // Only the roles in departments they manage.
    expect(byName.both?.departments).toEqual([{ id: x.A, role: "member" }]);
    // Admins see everyone, with every role.
    const all = (
      (await (await get("/api/users", x.people.admin)).json()) as {
        users: { username: string; departments: unknown[] }[];
      }
    ).users;
    expect(all.find((u) => u.username === `both-${x.tag}`)?.departments).toHaveLength(2);
    expect(all.some((u) => u.username === `nobody-${x.tag}`)).toBe(true);
  });

  test("managers add plain viewers and members to their departments only", async () => {
    const add = (body: Record<string, unknown>) =>
      send("POST", "/api/users", x.people.managerA, {
        username: `new-${randomUUID().slice(0, 6)}`,
        key: newLoginKey(),
        ...body,
      });
    expect((await add({ departments: [{ id: x.A, role: "member" }] })).status).toBe(201);
    expect((await add({ departments: [{ id: x.A, role: "viewer" }] })).status).toBe(201);
    expect((await add({ departments: [] })).status).toBe(400);
    expect((await add({})).status).toBe(400);
    expect((await add({ departments: [{ id: x.A, role: "manager" }] })).status).toBe(403);
    expect((await add({ departments: [{ id: x.B, role: "member" }] })).status).toBe(403);
    expect((await add({ role: "viewer", departments: [{ id: x.A, role: "member" }] })).status).toBe(
      403,
    );
    expect(
      (
        await send("POST", "/api/users", x.people.memberA, {
          username: `nope-${x.tag}`,
          key: newLoginKey(),
          departments: [{ id: x.A, role: "member" }],
        })
      ).status,
    ).toBe(403);
  });

  test("managers change, disable, reset and delete the users they manage", async () => {
    const change = (who: Person, target: Person, body: Record<string, unknown>) =>
      send("PATCH", `/api/users/${x.people[target].id}`, x.people[who], body);
    expect(
      (await change("managerA", "deptViewerA", { departments: [{ id: x.A, role: "member" }] }))
        .status,
    ).toBe(200);
    expect((await change("managerA", "deptViewerA", { disabled: true })).status).toBe(200);
    expect((await change("managerA", "deptViewerA", { disabled: false })).status).toBe(200);
    expect((await change("managerA", "deptViewerA", { key: newLoginKey() })).status).toBe(200);
    expect((await change("managerA", "deptViewerA", { reset_2fa: true })).status).toBe(200);
    expect((await change("managerA", "deptViewerA", { role: "viewer" })).status).toBe(403);
    expect(
      (await change("managerA", "deptViewerA", { departments: [{ id: x.B, role: "member" }] }))
        .status,
    ).toBe(403);
    expect((await change("managerA", "deptViewerA", { departments: [] })).status).toBe(400);
    expect((await change("managerA", "both", { disabled: true })).status).toBe(403);
    expect((await change("managerA", "viewerManagerA", { disabled: true })).status).toBe(403);
    expect((await change("managerA", "managerB", { disabled: true })).status).toBe(404);
    expect((await change("managerA", "managerA", { disabled: true })).status).toBe(409);
    expect((await change("viewer", "memberA", { disabled: true })).status).toBe(403);
    // Deleting: their machines become shared.
    expect(
      (await send("DELETE", `/api/users/${x.people.memberA.id}`, x.people.managerB)).status,
    ).toBe(404);
    expect(
      (await send("DELETE", `/api/users/${x.people.memberA.id}`, x.people.managerA)).status,
    ).toBe(200);
    expect(await w.sql("SELECT owner_id FROM machines WHERE id = ?1", x.machines.a1.id)).toEqual([
      { owner_id: null },
    ]);
  });

  test("leaving a department gives up the machines owned there", async () => {
    const res = await send("PATCH", `/api/users/${x.people.memberB.id}`, x.people.admin, {
      departments: [{ id: x.A, role: "member" }],
    });
    expect(res.status).toBe(200);
    expect(await w.sql("SELECT owner_id FROM machines WHERE id = ?1", x.machines.b1.id)).toEqual([
      { owner_id: null },
    ]);
  });

  test("admins give dashboard-wide roles; the last admin stays", async () => {
    const res = await send("PATCH", `/api/users/${x.people.nobody.id}`, x.people.admin, {
      role: "viewer",
    });
    expect(res.status).toBe(200);
    expect(
      (await send("PATCH", `/api/users/${x.people.nobody.id}`, x.people.admin, { role: null }))
        .status,
    ).toBe(200);
  });
});

describe("departments", () => {
  let x: World;
  beforeAll(async () => {
    x = await world();
  });
  const names = async (who: Person) =>
    (
      (await (await get("/api/departments", x.people[who])).json()) as {
        departments: { name: string; my_role: string | null }[];
      }
    ).departments
      .filter((d) => d.name.endsWith(x.tag))
      .map((d) => `${d.name.replace(` ${x.tag}`, "")}:${d.my_role ?? "-"}`);

  test("each person sees the departments they have a role or a machine in", async () => {
    expect(await names("admin")).toEqual(["Design:-", "Sales:-"]);
    expect(await names("viewer")).toEqual(["Design:-", "Sales:-"]);
    expect(await names("managerA")).toEqual(["Design:manager"]);
    expect(await names("both")).toEqual(["Design:member", "Sales:member"]);
    expect(await names("nobody")).toEqual([]);
  });

  test("only admins create, rename and delete them", async () => {
    expect(
      (await send("POST", "/api/departments", x.people.managerA, { name: "Nope" })).status,
    ).toBe(403);
    expect(
      (await send("PATCH", `/api/departments/${x.A}`, x.people.managerA, { name: "Nope" })).status,
    ).toBe(403);
    expect((await send("DELETE", `/api/departments/${x.A}`, x.people.managerA)).status).toBe(403);
    const created = await send("POST", "/api/departments", x.people.admin, {
      name: `Ops ${x.tag}`,
    });
    expect(created.status).toBe(201);
    expect(
      (await send("POST", "/api/departments", x.people.admin, { name: `ops ${x.tag}` })).status,
    ).toBe(409);
    expect(
      (await send("PATCH", `/api/departments/${x.B}`, x.people.admin, { name: `Design ${x.tag}` }))
        .status,
    ).toBe(409);
  });

  test("deleting one leaves its machines without a department, and its people without a role there", async () => {
    expect((await send("DELETE", `/api/departments/${x.A}`, x.people.admin)).status).toBe(200);
    expect(
      await w.sql("SELECT department_id, owner_id FROM machines WHERE id = ?1", x.machines.a1.id),
    ).toEqual([{ department_id: null, owner_id: x.people.memberA.id }]);
    expect(await machinesSeen(x, "managerA")).toEqual([]);
    expect(await machinesSeen(x, "memberA")).toEqual(["a1", "lent"]);
  });
});

describe("settings and the account", () => {
  let x: World;
  beforeAll(async () => {
    x = await world();
  });

  test("settings are for dashboard-wide roles", async () => {
    expect((await get("/api/settings", x.people.admin)).status).toBe(200);
    expect((await get("/api/settings", x.people.viewer)).status).toBe(200);
    for (const who of ["managerA", "deptViewerA", "memberA", "nobody"] as Person[]) {
      expect((await get("/api/settings", x.people[who])).status).toBe(403);
      expect((await send("POST", "/api/settings/check-updates", x.people[who])).status).toBe(403);
    }
    expect(
      (await send("PATCH", "/api/settings", x.people.viewer, { timezone: "UTC" })).status,
    ).toBe(403);
  });

  test("/api/me lists the person's departments and roles", async () => {
    const me = (await (await get("/api/me", x.people.both)).json()) as {
      role: string | null;
      departments: { name: string; role: string }[];
    };
    expect(me.role).toBeNull();
    expect(me.departments.map((d) => `${d.name}:${d.role}`)).toEqual([
      `Design ${x.tag}:member`,
      `Sales ${x.tag}:member`,
    ]);
  });
});
