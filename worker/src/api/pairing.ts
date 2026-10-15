import type { Context } from "hono";
import { z } from "zod";
import { normalizeUserCode } from "../agent/pair";
import { checkDepartment, checkOwner, isAdmin, manages, managesSomething } from "../auth/access";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { MachineName, nameTaken } from "./machines";

/** GET /api/pairing (admin) — machines currently waiting to join. */
export async function listPairing(c: Context<AppEnv>): Promise<Response> {
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_code, machine_name, os, arch, agent_version, client_ip, created_at, expires_at
       FROM pairing_requests
      WHERE status = 'pending' AND expires_at > ?1
      ORDER BY created_at DESC`,
  )
    .bind(Date.now())
    .all();
  return c.json({ requests: results });
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
