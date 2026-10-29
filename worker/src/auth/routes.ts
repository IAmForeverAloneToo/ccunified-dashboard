import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { clearFailures, clientIp, countAttempt, forgetAttempt, type Limit } from "../lib/ratelimit";
import { LOGIN_KDF } from "./client-kdf";
import {
  burnLoginCheck,
  decodeLoginKey,
  hashLoginKey,
  LOGIN_KEY_RE,
  verifyLoginKey,
} from "./password";
import { endOtherSessions, endSession, startSession } from "./session";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "./totp";

const WINDOW_MS = 15 * 60 * 1000;
const USER_MAX_FAILURES = 10;
const IP_MAX_FAILURES = 50;

const LoginKey = z.string().regex(LOGIN_KEY_RE, "must be a 32-byte base64url login key");
const Code = z.string().trim().min(1).max(32);

interface UserRow {
  id: string;
  username: string;
  role: "admin" | "viewer";
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  must_change_password: number;
}

/** The account's limit and the address's. */
type Limits = [user: Limit, ip: Limit];

function limitsFor(username: string, ip: string): Limits {
  return [
    { key: `user:${username.toLowerCase()}`, max: USER_MAX_FAILURES, windowMs: WINDOW_MS },
    { key: `ip:${ip}`, max: IP_MAX_FAILURES, windowMs: WINDOW_MS },
  ];
}

/**
 * Counts the attempt before checking anything, and refuses it once the
 * account or the address has had too many: attempts sent at once can't all
 * get through. Attempts that fail stay counted.
 */
async function countOrRefuse(c: Context<AppEnv>, limits: Limits): Promise<void> {
  const wait = await countAttempt(c.env.DB, limits);
  if (wait > 0) {
    fail(429, "too_many_attempts", { retry_after_seconds: wait }, { "retry-after": String(wait) });
  }
}

/** A right password: takes the attempt back, so it doesn't count as a failure. */
function forgetAttempts(db: D1Database, limits: Limits): D1PreparedStatement[] {
  return limits.map((l) => forgetAttempt(db, l.key));
}

/** A completed sign-in or check: clears the account's failures and takes back the attempt. */
function succeeded(db: D1Database, [user, ip]: Limits): D1PreparedStatement[] {
  return [clearFailures(db, user.key), forgetAttempt(db, ip.key)];
}

/**
 * Checks a second factor and uses it up: a 6-digit authenticator code (it
 * and older ones then stop working), or a recovery code. The use is a
 * conditional write, so a code sent twice at once works only once.
 */
async function useSecondFactor(db: D1Database, user: UserRow, code: string): Promise<boolean> {
  if (user.totp_secret && /^\d{6}$/.test(code)) {
    const step = await verifyTotp(user.totp_secret, code, user.totp_last_step);
    if (step === null) return false;
    const res = await db
      .prepare(
        `UPDATE users SET totp_last_step = ?1
          WHERE id = ?2 AND (totp_last_step IS NULL OR totp_last_step < ?1)`,
      )
      .bind(step, user.id)
      .run();
    return res.meta.changes === 1;
  }
  const res = await db
    .prepare(
      "UPDATE recovery_codes SET used_at = ?1 WHERE user_id = ?2 AND code_hash = ?3 AND used_at IS NULL",
    )
    .bind(Date.now(), user.id, await hashRecoveryCode(code))
    .run();
  return res.meta.changes === 1;
}

async function loadUser(db: D1Database, where: "id" | "username", value: string) {
  return db
    .prepare(
      `SELECT id, username, role, password_hash, totp_secret, totp_enabled, totp_last_step,
              must_change_password
         FROM users WHERE ${where === "id" ? "id" : "username"} = ?1 AND disabled_at IS NULL`,
    )
    .bind(value)
    .first<UserRow>();
}

/** GET /api/login-params — what the browser needs to derive the login key. Public. */
export async function loginParams(c: Context<AppEnv>): Promise<Response> {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'install_id'").first<{
    value: string;
  }>();
  return c.json({
    install_id: row?.value ?? "",
    kdf: "PBKDF2-SHA256",
    iterations: LOGIN_KDF.iterations,
    version: LOGIN_KDF.version,
  });
}

/** POST /api/login */
export async function login(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(
    c,
    z.strictObject({ username: z.string().min(1).max(64), key: LoginKey, code: Code.optional() }),
  );
  const db = c.env.DB;
  const key = decodeLoginKey(body.key);
  if (!key) fail(400, "invalid_request");
  const limits = limitsFor(body.username, clientIp(c.req.raw.headers));
  await countOrRefuse(c, limits);

  const user = await loadUser(db, "username", body.username);
  if (!user) {
    await burnLoginCheck(key);
    fail(401, "invalid_credentials");
  }
  if (!(await verifyLoginKey(user.password_hash, key))) fail(401, "invalid_credentials");

  if (user.totp_enabled === 1) {
    if (!body.code) {
      // The password was right; the browser asks for the code and tries again.
      await db.batch(forgetAttempts(db, limits));
      fail(401, "totp_required");
    }
    if (!(await useSecondFactor(db, user, body.code))) fail(401, "invalid_code");
  }

  await db.batch([
    db.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(Date.now(), user.id),
    ...succeeded(db, limits),
  ]);
  await startSession(c, user.id);
  return c.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      totp_enabled: user.totp_enabled === 1,
      must_change_password: user.must_change_password === 1,
    },
  });
}

/** POST /api/logout */
export async function logout(c: Context<AppEnv>): Promise<Response> {
  await endSession(c);
  return c.json({ ok: true });
}

/**
 * Re-checks the current user's password (login key) for sensitive changes,
 * counted like logins. Returns the user, and the statements that clear the
 * count once the change goes ahead (a wrong second factor still counts).
 */
async function confirmPassword(
  c: Context<AppEnv>,
  keyText: string,
): Promise<{ user: UserRow; done: D1PreparedStatement[] }> {
  const me = c.get("user");
  const limits = limitsFor(me.username, clientIp(c.req.raw.headers));
  await countOrRefuse(c, limits);
  const user = await loadUser(c.env.DB, "id", me.id);
  const key = decodeLoginKey(keyText);
  if (!user || !key || !(await verifyLoginKey(user.password_hash, key))) {
    fail(401, "invalid_credentials");
  }
  return { user, done: succeeded(c.env.DB, limits) };
}

/** POST /api/me/password — change your own password; signs out your other sessions. */
export async function changePassword(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ current_key: LoginKey, new_key: LoginKey }));
  const { user, done } = await confirmPassword(c, body.current_key);
  if (body.new_key === body.current_key) fail(400, "same_password");
  const newKey = decodeLoginKey(body.new_key);
  if (!newKey) fail(400, "invalid_request");
  const me = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?1, must_change_password = 0, password_changed_at = ?2 WHERE id = ?3",
    ).bind(await hashLoginKey(newKey), Date.now(), user.id),
    endOtherSessions(c.env.DB, user.id, me.sessionHash),
    ...done,
  ]);
  return c.json({ ok: true });
}

/** POST /api/me/2fa/setup — starts two-factor setup; returns the secret for the authenticator app. */
export async function startTotpSetup(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ key: LoginKey }));
  const { user, done } = await confirmPassword(c, body.key);
  if (user.totp_enabled === 1) fail(409, "already_enabled");
  const secret = newTotpSecret();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_secret = ?1 WHERE id = ?2").bind(secret, user.id),
    ...done,
  ]);
  return c.json({
    secret,
    otpauth_uri: otpauthUri(secret, user.username, new URL(c.req.url).host),
  });
}

async function storeRecoveryCodes(db: D1Database, userId: string) {
  const codes = newRecoveryCodes();
  const statements = [db.prepare("DELETE FROM recovery_codes WHERE user_id = ?1").bind(userId)];
  for (const code of codes) {
    statements.push(
      db
        .prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?1, ?2)")
        .bind(userId, await hashRecoveryCode(code)),
    );
  }
  return { codes, statements };
}

/** POST /api/me/2fa/enable — confirms setup with a code from the app; returns recovery codes once. */
export async function enableTotp(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ code: Code }));
  const user = await loadUser(c.env.DB, "id", c.get("user").id);
  if (!user) fail(401, "not_logged_in");
  if (user.totp_enabled === 1) fail(409, "already_enabled");
  if (!user.totp_secret) fail(409, "setup_not_started");
  const step = await verifyTotp(user.totp_secret, body.code, user.totp_last_step);
  if (step === null) fail(400, "invalid_code");
  const { codes, statements } = await storeRecoveryCodes(c.env.DB, user.id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 1, totp_last_step = ?1 WHERE id = ?2").bind(
      step,
      user.id,
    ),
    ...statements,
  ]);
  return c.json({ ok: true, recovery_codes: codes });
}

/** POST /api/me/2fa/disable — needs your password and a current code (or a recovery code). */
export async function disableTotp(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ key: LoginKey, code: Code }));
  const { user, done } = await confirmPassword(c, body.key);
  if (user.totp_enabled !== 1) fail(409, "not_enabled");
  if (!(await useSecondFactor(c.env.DB, user, body.code))) fail(400, "invalid_code");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?1",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?1").bind(user.id),
    ...done,
  ]);
  return c.json({ ok: true });
}

/** POST /api/me/2fa/recovery-codes — replaces your recovery codes. */
export async function regenerateRecoveryCodes(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ key: LoginKey, code: Code }));
  const { user, done } = await confirmPassword(c, body.key);
  if (user.totp_enabled !== 1) fail(409, "not_enabled");
  if (!(await useSecondFactor(c.env.DB, user, body.code))) fail(400, "invalid_code");
  const { codes, statements } = await storeRecoveryCodes(c.env.DB, user.id);
  await c.env.DB.batch([...statements, ...done]);
  return c.json({ ok: true, recovery_codes: codes });
}
