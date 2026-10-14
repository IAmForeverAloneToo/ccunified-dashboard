import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { clearFailures, clientIp, type Limit, recordFailure, retryAfter } from "../lib/ratelimit";
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

function limitsFor(username: string, ip: string): Limit[] {
  return [
    { key: `user:${username.toLowerCase()}`, max: USER_MAX_FAILURES, windowMs: WINDOW_MS },
    { key: `ip:${ip}`, max: IP_MAX_FAILURES, windowMs: WINDOW_MS },
  ];
}

async function refuseIfLocked(c: Context<AppEnv>, limits: Limit[]): Promise<void> {
  const wait = await retryAfter(c.env.DB, limits);
  if (wait > 0) {
    fail(429, "too_many_attempts", { retry_after_seconds: wait }, { "retry-after": String(wait) });
  }
}

async function failAttempt(c: Context<AppEnv>, limits: Limit[], error: string): Promise<never> {
  await c.env.DB.batch(limits.map((l) => recordFailure(c.env.DB, l)));
  fail(401, error);
}

/**
 * Checks a second factor: a 6-digit authenticator code, or a recovery code
 * (which is then used up). Returns the statements that record its use.
 */
async function checkSecondFactor(
  db: D1Database,
  user: UserRow,
  code: string,
): Promise<D1PreparedStatement[] | null> {
  if (user.totp_secret && /^\d{6}$/.test(code)) {
    const step = await verifyTotp(user.totp_secret, code, user.totp_last_step);
    if (step === null) return null;
    return [db.prepare("UPDATE users SET totp_last_step = ?1 WHERE id = ?2").bind(step, user.id)];
  }
  const hash = await hashRecoveryCode(code);
  const row = await db
    .prepare(
      "SELECT 1 FROM recovery_codes WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL",
    )
    .bind(user.id, hash)
    .first();
  if (!row) return null;
  return [
    db
      .prepare(
        "UPDATE recovery_codes SET used_at = ?1 WHERE user_id = ?2 AND code_hash = ?3 AND used_at IS NULL",
      )
      .bind(Date.now(), user.id, hash),
  ];
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
  const limits = limitsFor(body.username, clientIp(c.req.raw.headers));
  await refuseIfLocked(c, limits);

  const key = decodeLoginKey(body.key);
  if (!key) fail(400, "invalid_request");
  const user = await loadUser(c.env.DB, "username", body.username);
  if (!user) {
    await burnLoginCheck(key);
    return failAttempt(c, limits, "invalid_credentials");
  }
  if (!(await verifyLoginKey(user.password_hash, key))) {
    return failAttempt(c, limits, "invalid_credentials");
  }

  const writes: D1PreparedStatement[] = [];
  if (user.totp_enabled === 1) {
    if (!body.code) fail(401, "totp_required");
    const used = await checkSecondFactor(c.env.DB, user, body.code);
    if (!used) return failAttempt(c, limits, "invalid_code");
    writes.push(...used);
  }

  const [userLimit] = limits;
  writes.push(
    c.env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(Date.now(), user.id),
  );
  if (userLimit) writes.push(clearFailures(c.env.DB, userLimit.key));
  await c.env.DB.batch(writes);
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

/** Re-checks the current user's password (login key) for sensitive changes. */
async function confirmPassword(c: Context<AppEnv>, keyText: string): Promise<UserRow> {
  const me = c.get("user");
  const limits = limitsFor(me.username, clientIp(c.req.raw.headers));
  await refuseIfLocked(c, limits);
  const user = await loadUser(c.env.DB, "id", me.id);
  const key = decodeLoginKey(keyText);
  if (!user || !key || !(await verifyLoginKey(user.password_hash, key))) {
    return failAttempt(c, limits, "invalid_credentials");
  }
  return user;
}

/** POST /api/me/password — change your own password; signs out your other sessions. */
export async function changePassword(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ current_key: LoginKey, new_key: LoginKey }));
  const user = await confirmPassword(c, body.current_key);
  if (body.new_key === body.current_key) fail(400, "same_password");
  const newKey = decodeLoginKey(body.new_key);
  if (!newKey) fail(400, "invalid_request");
  const me = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?1, must_change_password = 0, password_changed_at = ?2 WHERE id = ?3",
    ).bind(await hashLoginKey(newKey), Date.now(), user.id),
    endOtherSessions(c.env.DB, user.id, me.sessionHash),
  ]);
  return c.json({ ok: true });
}

/** POST /api/me/2fa/setup — starts two-factor setup; returns the secret for the authenticator app. */
export async function startTotpSetup(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ key: LoginKey }));
  const user = await confirmPassword(c, body.key);
  if (user.totp_enabled === 1) fail(409, "already_enabled");
  const secret = newTotpSecret();
  await c.env.DB.prepare("UPDATE users SET totp_secret = ?1 WHERE id = ?2")
    .bind(secret, user.id)
    .run();
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
  const user = await confirmPassword(c, body.key);
  if (user.totp_enabled !== 1) fail(409, "not_enabled");
  const used = await checkSecondFactor(c.env.DB, user, body.code);
  if (!used) fail(400, "invalid_code");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?1",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?1").bind(user.id),
  ]);
  return c.json({ ok: true });
}

/** POST /api/me/2fa/recovery-codes — replaces your recovery codes. */
export async function regenerateRecoveryCodes(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ key: LoginKey, code: Code }));
  const user = await confirmPassword(c, body.key);
  if (user.totp_enabled !== 1) fail(409, "not_enabled");
  const used = await checkSecondFactor(c.env.DB, user, body.code);
  if (!used) fail(400, "invalid_code");
  const { codes, statements } = await storeRecoveryCodes(c.env.DB, user.id);
  await c.env.DB.batch([...used, ...statements]);
  return c.json({ ok: true, recovery_codes: codes });
}
