import type { Context } from "hono";
import { z } from "zod";
import {
  checkDepartment,
  checkOwner,
  departmentsWith,
  isAdmin,
  manages,
  managesSomething,
} from "../auth/access";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail, readJson } from "../lib/http";

// Enrollment keys, for adding many machines with a script (see
// agent/enroll.ts). Admins manage every key; managers the keys of the
// departments they manage. A key is shown once, when it's created.

const KeyName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}]+$/u, "no control characters");

const NewKey = z.strictObject({
  name: KeyName,
  department_id: z.string().max(64).nullable(),
  owner_id: z.string().max(64).nullable(),
  /** Days until it stops working, or null for never. */
  expires_in_days: z.number().int().min(1).max(3650).nullable(),
  /** How many machines may enroll with it, or null for any number. */
  max_uses: z.number().int().min(1).max(100_000).nullable(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** GET /api/enrollment-keys (admins, managers) — the keys the user manages, newest first. */
export async function listEnrollmentKeys(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.department_id, d.name AS department_name, k.owner_id,
            o.username AS owner_username, b.username AS created_by, k.created_at, k.expires_at,
            k.max_uses, k.uses, k.last_used_at, k.revoked_at,
            (SELECT COUNT(*) FROM pairing_requests p
              WHERE p.enrollment_key_id = k.id AND p.status = 'pending' AND p.expires_at > ?3) AS waiting
       FROM enrollment_keys k
       LEFT JOIN departments d ON d.id = k.department_id
       LEFT JOIN users o ON o.id = k.owner_id
       LEFT JOIN users b ON b.id = k.created_by
      WHERE ?1 = 1 OR k.department_id IN (SELECT value FROM json_each(?2))
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
  )
    .bind(isAdmin(u) ? 1 : 0, JSON.stringify(departmentsWith(u, "manager")), Date.now())
    .all<{
      department_id: string | null;
      department_name: string | null;
      owner_id: string | null;
      owner_username: string | null;
    }>();
  return c.json({
    keys: results.map(({ department_id, department_name, owner_id, owner_username, ...k }) => ({
      ...k,
      department: department_id ? { id: department_id, name: department_name } : null,
      owner: owner_id ? { id: owner_id, username: owner_username } : null,
    })),
  });
}

/**
 * POST /api/enrollment-keys (admins, managers) — creates a key and returns it
 * (the only time it's shown). Managers' keys are for a department they
 * manage; the owner, if any, must be able to own machines there.
 */
export async function createEnrollmentKey(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const body = await readJson(c, NewKey);
  const db = c.env.DB;
  if (body.department_id === null ? !isAdmin(u) : !manages(u, body.department_id)) {
    fail(403, "department_required");
  }
  if (body.department_id !== null) await checkDepartment(db, body.department_id);
  await checkOwner(db, u, body.department_id, body.owner_id);
  const key = `ccu_e_${randomToken(32)}`;
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO enrollment_keys (id, name, key_hash, department_id, owner_id, created_by,
                                    created_at, expires_at, max_uses)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      id,
      body.name,
      await sha256Hex(key),
      body.department_id,
      body.owner_id,
      u.id,
      now,
      body.expires_in_days === null ? null : now + body.expires_in_days * DAY_MS,
      body.max_uses,
    )
    .run();
  return c.json({ id, key }, 201);
}

/**
 * DELETE /api/enrollment-keys/:id (admins, managers of its department) —
 * revokes the key: no more machines can enroll with it, and the machines
 * still waiting with it are denied.
 */
export async function revokeEnrollmentKey(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const db = c.env.DB;
  const key = await db
    .prepare("SELECT id, department_id, revoked_at FROM enrollment_keys WHERE id = ?1")
    .bind(c.req.param("id") ?? "")
    .first<{ id: string; department_id: string | null; revoked_at: number | null }>();
  if (!key || !manages(u, key.department_id)) fail(404, "not_found");
  if (key.revoked_at !== null) fail(404, "not_found");
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE enrollment_keys SET revoked_at = ?1 WHERE id = ?2").bind(now, key.id),
    db
      .prepare(
        `UPDATE pairing_requests SET status = 'denied', decided_by = ?1, decided_at = ?2
          WHERE enrollment_key_id = ?3 AND status = 'pending'`,
      )
      .bind(u.id, now, key.id),
  ]);
  return c.json({ ok: true });
}
