import type { Context } from "hono";
import { z } from "zod";
import { normalizeUserCode } from "../agent/pair";
import {
  checkDepartment,
  checkOwner,
  departmentsWith,
  isAdmin,
  manages,
  managesSomething,
} from "../auth/access";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { freeName, MachineName, nameTaken, takenNames } from "./machines";

/**
 * GET /api/pairing (admins, managers) — machines currently waiting to join.
 * Admins see them all; managers see the machines that enrolled with a key of
 * a department they manage. Machines that enrolled with a key have `key`
 * (and are approved from this list); the others show a code on their screen.
 */
export async function listPairing(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.machine_name, p.os, p.arch, p.agent_version, p.client_ip, p.created_at,
            p.expires_at, p.department_id, d.name AS department_name, p.owner_id,
            o.username AS owner_username, p.enrollment_key_id, k.name AS key_name
       FROM pairing_requests p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN users o ON o.id = p.owner_id
       LEFT JOIN enrollment_keys k ON k.id = p.enrollment_key_id
      WHERE p.status = 'pending' AND p.expires_at > ?1
        AND (?2 = 1 OR (p.enrollment_key_id IS NOT NULL
                        AND p.department_id IN (SELECT value FROM json_each(?3))))
      ORDER BY p.created_at DESC
      LIMIT 2000`,
  )
    .bind(Date.now(), isAdmin(u) ? 1 : 0, JSON.stringify(departmentsWith(u, "manager")))
    .all<{
      department_id: string | null;
      department_name: string | null;
      owner_id: string | null;
      owner_username: string | null;
      enrollment_key_id: string | null;
      key_name: string | null;
    }>();
  return c.json({
    requests: results.map(
      ({
        department_id,
        department_name,
        owner_id,
        owner_username,
        enrollment_key_id,
        key_name,
        ...r
      }) => ({
        ...r,
        department: department_id ? { id: department_id, name: department_name } : null,
        owner: owner_id ? { id: owner_id, username: owner_username } : null,
        key: enrollment_key_id ? { id: enrollment_key_id, name: key_name } : null,
      }),
    ),
  });
}

/**
 * POST /api/pairing/decide (admins, managers) — `{ ids, approve }`: approves
 * or denies machines that enrolled with a key, into the key's department and
 * with its owner. Managers decide for the departments they manage. A name
 * another machine has gets a number ("LAPTOP-2").
 */
export async function decidePairing(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const body = await readJson(
    c,
    z.strictObject({ ids: z.array(z.string().max(64)).min(1).max(500), approve: z.boolean() }),
  );
  const db = c.env.DB;
  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT id, machine_name, department_id FROM pairing_requests
        WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending'
          AND expires_at > ?2 AND enrollment_key_id IS NOT NULL`,
    )
    .bind(JSON.stringify([...new Set(body.ids)]), now)
    .all<{ id: string; machine_name: string; department_id: string | null }>();
  const mine = results.filter((r) => manages(u, r.department_id));
  if (mine.length === 0) fail(404, "not_found");

  const names: Record<string, string> = {};
  const updates: D1PreparedStatement[] = [];
  if (body.approve) {
    // Each name is free among active machines and the other waiting ones.
    const taken = await takenNames(
      db,
      mine.map((r) => r.id),
    );
    for (const r of mine) {
      const name = freeName(r.machine_name, taken);
      taken.add(name.toLowerCase());
      names[r.id] = name;
      updates.push(
        db
          .prepare(
            `UPDATE pairing_requests
                SET status = 'approved', machine_name = ?1, decided_by = ?2, decided_at = ?3
              WHERE id = ?4 AND status = 'pending'`,
          )
          .bind(name, u.id, now, r.id),
      );
    }
  } else {
    for (const r of mine) {
      updates.push(
        db
          .prepare(
            `UPDATE pairing_requests SET status = 'denied', decided_by = ?1, decided_at = ?2
              WHERE id = ?3 AND status = 'pending'`,
          )
          .bind(u.id, now, r.id),
      );
    }
  }
  await db.batch(updates);
  return c.json({ ok: true, decided: mine.length, names });
}

async function findPending(c: Context<AppEnv>, code: string) {
  const userCode = normalizeUserCode(code);
  if (!userCode) fail(400, "invalid_code");
  const req = await c.env.DB.prepare(
    `SELECT id, machine_name FROM pairing_requests
      WHERE user_code = ?1 AND status = 'pending' AND expires_at > ?2`,
  )
    .bind(userCode, Date.now())
    .first<{ id: string; machine_name: string }>();
  if (!req) fail(404, "not_found");
  return req;
}

/**
 * POST /api/pairing/approve (admins and managers) — `{ user_code, name?,
 * department_id?, owner_id? }`; `name` overrides the machine's suggestion.
 * Managers approve into a department they manage; admins may leave it out.
 * The owner, if any, must have a role in that department (see checkOwner).
 */
export async function approvePairing(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const body = await readJson(
    c,
    z.strictObject({
      user_code: z.string().max(32),
      name: MachineName.optional(),
      department_id: z.string().max(64).nullable().optional(),
      owner_id: z.string().max(64).nullable().optional(),
    }),
  );
  const department = body.department_id ?? null;
  const owner = body.owner_id ?? null;
  if (department === null ? !isAdmin(u) : !manages(u, department)) {
    fail(403, "department_required");
  }
  if (department !== null) await checkDepartment(c.env.DB, department);
  await checkOwner(c.env.DB, u, department, owner);
  const req = await findPending(c, body.user_code);
  const name = body.name ?? req.machine_name;
  if (await nameTaken(c.env.DB, name)) fail(409, "name_taken", { name });
  const res = await c.env.DB.prepare(
    `UPDATE pairing_requests
        SET status = 'approved', machine_name = ?1, decided_by = ?2, decided_at = ?3,
            department_id = ?4, owner_id = ?5
      WHERE id = ?6 AND status = 'pending'`,
  )
    .bind(name, u.id, Date.now(), department, owner, req.id)
    .run();
  if (res.meta.changes !== 1) fail(404, "not_found");
  return c.json({ ok: true, name });
}

/** POST /api/pairing/deny (admins and managers) — `{ user_code }` */
export async function denyPairing(c: Context<AppEnv>): Promise<Response> {
  if (!managesSomething(c.get("user"))) fail(403, "forbidden");
  const body = await readJson(c, z.strictObject({ user_code: z.string().max(32) }));
  const req = await findPending(c, body.user_code);
  await c.env.DB.prepare(
    "UPDATE pairing_requests SET status = 'denied', decided_by = ?1, decided_at = ?2 WHERE id = ?3",
  )
    .bind(c.get("user").id, Date.now(), req.id)
    .run();
  return c.json({ ok: true });
}
