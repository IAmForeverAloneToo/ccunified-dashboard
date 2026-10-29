import type { Context } from "hono";
import { z } from "zod";
import { PAIRING_TTL_MS } from "../agent/pair";
import { seesAll } from "../auth/access";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";

/** Department names: 1–64 printable characters. */
export const DepartmentName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}]+$/u, "no control characters");

interface DepartmentRow {
  id: string;
  name: string;
  created_at: number;
  machines: number;
  people: number;
}

/**
 * GET /api/departments — every department for admins and dashboard-wide
 * viewers; otherwise the ones the user has a role in or owns a machine in.
 * Each with its number of machines and people, and the user's own role.
 */
export async function listDepartments(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const all = seesAll(u);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.created_at,
            (SELECT COUNT(*) FROM machines m WHERE m.department_id = d.id AND m.revoked_at IS NULL) AS machines,
            (SELECT COUNT(*) FROM department_roles r WHERE r.department_id = d.id) AS people
       FROM departments d
      WHERE ?1 = 1
         OR d.id IN (SELECT department_id FROM department_roles WHERE user_id = ?2)
         OR d.id IN (SELECT department_id FROM machines WHERE owner_id = ?2)
      ORDER BY d.name COLLATE NOCASE`,
  )
    .bind(all ? 1 : 0, u.id)
    .all<DepartmentRow>();
  return c.json({
    departments: results.map((d) => ({ ...d, my_role: u.departments.get(d.id) ?? null })),
  });
}

async function nameTaken(db: D1Database, name: string, except: string | null): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM departments WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2")
    .bind(name, except)
    .first();
  return row !== null;
}

/** POST /api/departments (admin) — `{ name }` */
export async function createDepartment(c: Context<AppEnv>): Promise<Response> {
  const { name } = await readJson(c, z.strictObject({ name: DepartmentName }));
  if (await nameTaken(c.env.DB, name, null)) fail(409, "name_taken");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO departments (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(id, name, Date.now())
    .run();
  return c.json({ ok: true, id }, 201);
}

/** PATCH /api/departments/:id (admin) — `{ name }` */
export async function renameDepartment(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const { name } = await readJson(c, z.strictObject({ name: DepartmentName }));
  if (await nameTaken(c.env.DB, name, id)) fail(409, "name_taken");
  const res = await c.env.DB.prepare("UPDATE departments SET name = ?1 WHERE id = ?2")
    .bind(name, id)
    .run();
  if (res.meta.changes !== 1) fail(404, "not_found");
  return c.json({ ok: true });
}

/**
 * DELETE /api/departments/:id (admin) — its machines are left without a
 * department (keeping their owners), and its people lose their roles there.
 * Its enrollment keys are deleted, and the machines still waiting with them
 * are denied first: without their key they would look like machines showing
 * a code.
 */
export async function deleteDepartment(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const db = c.env.DB;
  // Also any enrolled machine that already lost its key: only enrolled
  // machines wait longer than a code's 10 minutes.
  const [, res] = await db.batch([
    db
      .prepare(
        `UPDATE pairing_requests SET status = 'denied', decided_by = ?1, decided_at = ?2
          WHERE status = 'pending'
            AND (enrollment_key_id IN (SELECT id FROM enrollment_keys WHERE department_id = ?3)
                 OR (enrollment_key_id IS NULL AND expires_at - created_at > ?4))`,
      )
      .bind(c.get("user").id, Date.now(), id, PAIRING_TTL_MS),
    db.prepare("DELETE FROM departments WHERE id = ?1").bind(id),
  ]);
  // D1 counts the rows its foreign keys changed too.
  if (res?.meta.changes === 0) fail(404, "not_found");
  return c.json({ ok: true });
}
