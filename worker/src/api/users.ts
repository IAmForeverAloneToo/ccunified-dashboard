import type { Context } from "hono";
import { z } from "zod";
import { canManageUser, departmentsWith, isAdmin, manages, managesSomething } from "../auth/access";
import { decodeLoginKey, hashLoginKey, LOGIN_KEY_RE } from "../auth/password";
import { endOtherSessions } from "../auth/session";
import type { AppEnv, DashboardRole, DepartmentRole, SessionUser } from "../env";
import { fail, readJson } from "../lib/http";

/** Usernames are part of the password salt, so they cannot be renamed. */
export const Username = z
  .string()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, "3-32 letters, digits, '.', '_' or '-'");
const Role = z.enum(["admin", "viewer"]).nullable();
const LoginKey = z.string().regex(LOGIN_KEY_RE);
/** A user's roles in departments; each department at most once. */
const DepartmentRoles = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(64),
      role: z.enum(["manager", "viewer", "member"]),
    }),
  )
  .max(200)
  .refine((list) => new Set(list.map((d) => d.id)).size === list.length, {
    message: "a department appears twice",
  });
type DepartmentRoles = z.infer<typeof DepartmentRoles>;

interface UserListRow {
  id: string;
  username: string;
  role: DashboardRole | null;
  departments: string;
  totp_enabled: number;
  must_change_password: number;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
}

const rolesOf = (json: string) =>
  new Map(Object.entries(JSON.parse(json) as Record<string, DepartmentRole>));

/**
 * GET /api/users — admins see everyone; managers see the people with a role
 * in a department they manage (and only those roles). Each user says whether
 * the caller can manage them.
 */
export async function listUsers(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const managed = isAdmin(u) ? null : departmentsWith(u, "manager");
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, role, totp_enabled, must_change_password, created_at, last_login_at,
            disabled_at,
            (SELECT json_group_object(department_id, role) FROM department_roles
              WHERE user_id = users.id) AS departments
       FROM users
      WHERE ?1 IS NULL
         OR id IN (SELECT user_id FROM department_roles
                    WHERE department_id IN (SELECT value FROM json_each(?1)))
      ORDER BY disabled_at IS NOT NULL, username COLLATE NOCASE`,
  )
    .bind(managed === null ? null : JSON.stringify(managed))
    .all<UserListRow>();
  return c.json({
    users: results.map((row) => {
      const roles = rolesOf(row.departments);
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        departments: [...roles]
          .filter(([id]) => managed === null || managed.includes(id))
          .map(([id, role]) => ({ id, role })),
        totp_enabled: row.totp_enabled === 1,
        must_change_password: row.must_change_password === 1,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
        disabled_at: row.disabled_at,
        can_manage: canManageUser(u, { id: row.id, role: row.role, departments: roles }),
      };
    }),
  });
}

/**
 * Checks the department roles the caller may give: admins any, in departments
 * that exist; managers only "viewer" and "member", in departments they manage,
 * and at least one (so the person stays in view).
 */
async function checkGrants(db: D1Database, u: SessionUser, list: DepartmentRoles): Promise<void> {
  if (!isAdmin(u)) {
    if (list.length === 0) fail(400, "department_required");
    for (const d of list) {
      if (!manages(u, d.id) || d.role === "manager") fail(403, "forbidden");
    }
  }
  if (list.length === 0) return;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM departments WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(list.map((d) => d.id)))
    .first<{ n: number }>();
  if (row?.n !== list.length) fail(400, "unknown_department");
}

/** Statements that replace a user's department roles. */
function setRoles(db: D1Database, userId: string, list: DepartmentRoles): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM department_roles WHERE user_id = ?1").bind(userId),
    ...list.map((d) =>
      db
        .prepare("INSERT INTO department_roles (department_id, user_id, role) VALUES (?1, ?2, ?3)")
        .bind(d.id, userId, d.role),
    ),
    // Owners need a role in their machine's department.
    db
      .prepare(
        `UPDATE machines SET owner_id = NULL
          WHERE owner_id = ?1 AND department_id IS NOT NULL
            AND department_id NOT IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(list.map((d) => d.id))),
  ];
}

/**
 * POST /api/users (admins and managers) — the caller sets a first password
 * (as a login key derived in their browser); the new user must change it at
 * first login. Managers add people to departments they manage, as viewers or
 * members, without a dashboard-wide role.
 */
export async function createUser(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const body = await readJson(
    c,
    z.strictObject({
      username: Username,
      role: Role.optional(),
      departments: DepartmentRoles.optional(),
      key: LoginKey,
    }),
  );
  const role = body.role ?? null;
  const departments = body.departments ?? [];
  if (role !== null && !isAdmin(u)) fail(403, "forbidden");
  await checkGrants(c.env.DB, u, departments);
  const key = decodeLoginKey(body.key);
  if (!key) fail(400, "invalid_request");
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?1")
    .bind(body.username)
    .first();
  if (exists) fail(409, "username_taken");
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, password_changed_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
      )
      .bind(id, body.username, await hashLoginKey(key), role, now),
    ...setRoles(db, id, departments),
  ]);
  return c.json({ ok: true, id }, 201);
}

async function activeAdminCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Loads a user the caller manages; one they can't see is "not found". */
async function loadTarget(c: Context<AppEnv>) {
  const u = c.get("user");
  if (!managesSomething(u)) fail(403, "forbidden");
  const id = c.req.param("id") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT id, role, disabled_at,
            (SELECT json_group_object(department_id, role) FROM department_roles
              WHERE user_id = users.id) AS departments
       FROM users WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      id: string;
      role: DashboardRole | null;
      disabled_at: number | null;
      departments: string;
    }>();
  if (!row) fail(404, "not_found");
  const target = { ...row, departments: rolesOf(row.departments) };
  if (target.id === u.id) fail(409, "cannot_change_self");
  const visible = isAdmin(u) || [...target.departments.keys()].some((d) => manages(u, d));
  if (!visible) fail(404, "not_found");
  if (!canManageUser(u, target)) fail(403, "forbidden");
  return target;
}

const UserChange = z
  .strictObject({
    role: Role.optional(),
    departments: DepartmentRoles.optional(),
    disabled: z.boolean().optional(),
    key: LoginKey.optional(),
    reset_2fa: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

/**
 * PATCH /api/users/:id (admins, and managers for the users they manage) —
 * change the dashboard-wide role (admins only) or department roles,
 * disable/enable, set a new password (the user must change it at next
 * login), or turn off two-factor for someone who lost their authenticator.
 * People change their own account from the Account page instead.
 */
export async function updateUser(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const body = await readJson(c, UserChange);
  const target = await loadTarget(c);
  if (body.role !== undefined && !isAdmin(u)) fail(403, "forbidden");
  if (body.departments) await checkGrants(c.env.DB, u, body.departments);

  const losesAdmin =
    target.role === "admin" &&
    target.disabled_at === null &&
    ((body.role !== undefined && body.role !== "admin") || body.disabled === true);
  if (losesAdmin && (await activeAdminCount(c.env.DB)) <= 1) fail(409, "last_admin");

  const db = c.env.DB;
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  if (body.role !== undefined) {
    writes.push(db.prepare("UPDATE users SET role = ?1 WHERE id = ?2").bind(body.role, target.id));
  }
  if (body.departments) writes.push(...setRoles(db, target.id, body.departments));
  if (body.disabled !== undefined) {
    writes.push(
      db
        .prepare("UPDATE users SET disabled_at = ?1 WHERE id = ?2")
        .bind(body.disabled ? now : null, target.id),
    );
  }
  if (body.key) {
    const key = decodeLoginKey(body.key);
    if (!key) fail(400, "invalid_request");
    writes.push(
      db
        .prepare(
          "UPDATE users SET password_hash = ?1, must_change_password = 1, password_changed_at = ?2 WHERE id = ?3",
        )
        .bind(await hashLoginKey(key), now, target.id),
    );
  }
  if (body.reset_2fa) {
    writes.push(
      db
        .prepare(
          "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?1",
        )
        .bind(target.id),
      db.prepare("DELETE FROM recovery_codes WHERE user_id = ?1").bind(target.id),
    );
  }
  if (body.disabled || body.key || body.role !== undefined) {
    writes.push(endOtherSessions(db, target.id, null));
  }
  await db.batch(writes);
  return c.json({ ok: true });
}

/**
 * DELETE /api/users/:id (admins, and managers for the users they manage) —
 * machines the user owned become shared.
 */
export async function deleteUser(c: Context<AppEnv>): Promise<Response> {
  const target = await loadTarget(c);
  if (
    target.role === "admin" &&
    target.disabled_at === null &&
    (await activeAdminCount(c.env.DB)) <= 1
  ) {
    fail(409, "last_admin");
  }
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(target.id).run();
  return c.json({ ok: true });
}
