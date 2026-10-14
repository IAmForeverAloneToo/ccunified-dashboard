import type { Context } from "hono";
import { z } from "zod";
import { decodeLoginKey, hashLoginKey, LOGIN_KEY_RE } from "../auth/password";
import { endOtherSessions } from "../auth/session";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";

/** Usernames are part of the password salt, so they cannot be renamed. */
export const Username = z
  .string()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, "3-32 letters, digits, '.', '_' or '-'");
const Role = z.enum(["admin", "viewer"]);
const LoginKey = z.string().regex(LOGIN_KEY_RE);

interface UserListRow {
  id: string;
  username: string;
  role: "admin" | "viewer";
  totp_enabled: number;
  must_change_password: number;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
}

/** GET /api/users (admin) */
export async function listUsers(c: Context<AppEnv>): Promise<Response> {
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, role, totp_enabled, must_change_password, created_at, last_login_at, disabled_at
       FROM users ORDER BY disabled_at IS NOT NULL, username COLLATE NOCASE`,
  ).all<UserListRow>();
  return c.json({
    users: results.map((u) => ({
      ...u,
      totp_enabled: u.totp_enabled === 1,
      must_change_password: u.must_change_password === 1,
    })),
  });
}

/**
 * POST /api/users (admin) — the admin sets a first password (as a login key
 * derived in their browser); the new user must change it at first login.
 */
export async function createUser(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ username: Username, role: Role, key: LoginKey }));
  const key = decodeLoginKey(body.key);
  if (!key) fail(400, "invalid_request");
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?1")
    .bind(body.username)
    .first();
  if (exists) fail(409, "username_taken");
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, password_changed_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
  )
    .bind(id, body.username, await hashLoginKey(key), body.role, now)
    .run();
  return c.json({ ok: true, id }, 201);
}

async function activeAdminCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function loadTarget(c: Context<AppEnv>) {
  const id = c.req.param("id") ?? "";
  const user = await c.env.DB.prepare("SELECT id, role, disabled_at FROM users WHERE id = ?1")
    .bind(id)
    .first<{ id: string; role: "admin" | "viewer"; disabled_at: number | null }>();
  if (!user) fail(404, "not_found");
  return user;
}

const UserChange = z
  .strictObject({
    role: Role.optional(),
    disabled: z.boolean().optional(),
    key: LoginKey.optional(),
    reset_2fa: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

/**
 * PATCH /api/users/:id (admin) — change role, disable/enable, set a new
 * password (the user must change it at next login), or turn off two-factor
 * for someone who lost their authenticator. Admins change their own account
 * from the Account page instead.
 */
export async function updateUser(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, UserChange);
  const target = await loadTarget(c);
  if (target.id === c.get("user").id) fail(409, "cannot_change_self");

  const losesAdmin =
    target.role === "admin" &&
    target.disabled_at === null &&
    (body.role === "viewer" || body.disabled === true);
  if (losesAdmin && (await activeAdminCount(c.env.DB)) <= 1) fail(409, "last_admin");

  const db = c.env.DB;
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  if (body.role) {
    writes.push(db.prepare("UPDATE users SET role = ?1 WHERE id = ?2").bind(body.role, target.id));
  }
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
  if (body.disabled || body.key || body.role) writes.push(endOtherSessions(db, target.id, null));
  await db.batch(writes);
  return c.json({ ok: true });
}

/** DELETE /api/users/:id (admin) */
export async function deleteUser(c: Context<AppEnv>): Promise<Response> {
  const target = await loadTarget(c);
  if (target.id === c.get("user").id) fail(409, "cannot_change_self");
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
