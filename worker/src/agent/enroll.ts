import type { Context } from "hono";
import { z } from "zod";
import { freeName, MachineName, takenNames } from "../api/machines";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail, readJson } from "../lib/http";
import { clientIp, recordFailure, retryAfter } from "../lib/ratelimit";
import { newUserCode, POLL_INTERVAL_SECONDS } from "./pair";

// Enrolling is joining without a code, for scripts that set up many machines:
// the machine shows an enrollment key instead, and waits (for up to 30 days)
// on the Approvals page, where admins and the key's department's managers
// approve it, one at a time or many at once. It then polls like a paired
// machine (POST /agent/pair/poll) for its upload key.

export const ENROLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Machines waiting at once, from all keys. */
const MAX_WAITING = 5000;
/** Wrong keys from one address before it has to wait. */
const BAD_KEYS_PER_IP = { max: 10, windowMs: 10 * 60 * 1000 };

const EnrollBody = z.strictObject({
  enroll_key: z.string().min(1).max(128),
  machine_name: MachineName,
  os: z.enum(["windows", "linux", "darwin"]),
  arch: z.enum(["amd64", "arm64"]),
  agent_version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  sync_interval_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
});

interface KeyRow {
  id: string;
  department_id: string | null;
  owner_id: string | null;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
}

/** Looks up a usable key; wrong keys count toward the address's limit. */
async function usableKey(c: Context<AppEnv>, enrollKey: string, now: number): Promise<KeyRow> {
  const db = c.env.DB;
  const limit = { key: `enroll:${clientIp(c.req.raw.headers)}`, ...BAD_KEYS_PER_IP };
  const wait = await retryAfter(db, [limit], now);
  if (wait > 0) {
    fail(429, "too_many_requests", { retry_after_seconds: wait }, { "retry-after": String(wait) });
  }
  const key = await db
    .prepare(
      `SELECT id, department_id, owner_id, expires_at, max_uses, uses, revoked_at
         FROM enrollment_keys WHERE key_hash = ?1`,
    )
    .bind(await sha256Hex(enrollKey))
    .first<KeyRow>();
  if (!key) {
    await recordFailure(db, limit, now).run();
    fail(401, "invalid_enroll_key");
  }
  if (key.revoked_at !== null) fail(401, "enroll_key_revoked");
  if (key.expires_at !== null && key.expires_at <= now) fail(401, "enroll_key_expired");
  if (key.max_uses !== null && key.uses >= key.max_uses) fail(401, "enroll_key_used_up");
  return key;
}

/**
 * POST /agent/enroll/check — whether an enrollment key works, without using
 * it (a system-wide install checks its key before any account enrolls).
 */
export async function checkEnrollKey(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ enroll_key: z.string().min(1).max(128) }));
  await usableKey(c, body.enroll_key, Date.now());
  return c.json({ ok: true });
}

/**
 * POST /agent/enroll — a machine asks to join with an enrollment key. Its
 * name gets a number ("LAPTOP-2") when another machine has it.
 */
export async function enroll(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, EnrollBody);
  const db = c.env.DB;
  const now = Date.now();
  const key = await usableKey(c, body.enroll_key, now);

  const waiting = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM pairing_requests
        WHERE status = 'pending' AND expires_at > ?1 AND enrollment_key_id IS NOT NULL`,
    )
    .bind(now)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) >= MAX_WAITING) fail(429, "too_many_pending");

  const name = freeName(body.machine_name, await takenNames(db));
  const deviceCode = randomToken(32);
  // Counting the use only if it's still allowed keeps max_uses exact when
  // many machines enroll at once.
  const used = await db
    .prepare(
      `UPDATE enrollment_keys SET uses = uses + 1, last_used_at = ?1
        WHERE id = ?2 AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`,
    )
    .bind(now, key.id)
    .run();
  if (used.meta.changes !== 1) fail(401, "enroll_key_used_up");
  await db
    .prepare(
      `INSERT INTO pairing_requests (id, device_code_hash, user_code, machine_name, os, arch,
                                     agent_version, sync_interval_minutes, client_ip,
                                     created_at, expires_at, status, department_id, owner_id,
                                     enrollment_key_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14)`,
    )
    .bind(
      crypto.randomUUID(),
      await sha256Hex(deviceCode),
      // Never shown: enrolled machines are approved from the list, not by code.
      newUserCode(),
      name,
      body.os,
      body.arch,
      body.agent_version,
      body.sync_interval_minutes,
      clientIp(c.req.raw.headers),
      now,
      now + ENROLL_TTL_MS,
      key.department_id,
      key.owner_id,
      key.id,
    )
    .run();

  return c.json({
    device_code: deviceCode,
    machine_name: name,
    expires_in: ENROLL_TTL_MS / 1000,
    interval: POLL_INTERVAL_SECONDS,
  });
}
