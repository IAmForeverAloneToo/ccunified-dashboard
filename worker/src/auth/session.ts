import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, SessionUser } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail } from "../lib/http";

export const SESSION_COOKIE = "__Host-ccu_session";
/** Sessions last 14 days from login, then a new login is required. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;

const ROLE_RANK = { viewer: 1, admin: 2 } as const;

/** Creates a session for a user and sets the session cookie. */
export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)",
  )
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1")
      .bind(await sha256Hex(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

/** Loads the logged-in user from the session cookie, or returns undefined. */
export async function currentUser(c: Context<AppEnv>): Promise<SessionUser | undefined> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return undefined;
  const sessionHash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.totp_enabled, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?1 AND s.expires_at > ?2 AND u.disabled_at IS NULL`,
  )
    .bind(sessionHash, now)
    .first<{
      id: string;
      username: string;
      role: "admin" | "viewer";
      totp_enabled: number;
      last_seen_at: number;
    }>();
  if (!row) return undefined;
  if (row.last_seen_at < now - TOUCH_EVERY_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id_hash = ?2")
        .bind(now, sessionHash)
        .run(),
    );
  }
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    totpEnabled: row.totp_enabled === 1,
    sessionHash,
  };
}

/** Requires a logged-in user with at least the given role. */
export function requireUser(role: keyof typeof ROLE_RANK = "viewer"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await currentUser(c);
    if (!user) fail(401, "not_logged_in");
    if (ROLE_RANK[user.role] < ROLE_RANK[role]) fail(403, "forbidden");
    c.set("user", user);
    await next();
  };
}
