import type { Context } from "hono";
import { z } from "zod";
import { MachineName } from "../api/machines";
import type { AppEnv } from "../env";
import { randomBytes, randomToken, sha256Hex } from "../lib/crypto";
import { fail, readJson } from "../lib/http";
import { clientIp, recordFailure, retryAfter } from "../lib/ratelimit";
import { getSettings } from "../lib/settings";

// Joining a machine works like signing in a TV app: the machine asks for a
// pairing code and shows it; an admin types that code into the dashboard and
// approves it; the machine, which has been polling with a separate secret
// device code, then receives its upload key once.

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_SECONDS = 5;
const MAX_PENDING = 20;
const STARTS_PER_IP = { max: 5, windowMs: 10 * 60 * 1000 };

/** No 0/O, 1/I: easy to read off a terminal and type. 32 symbols, 8 characters = 40 bits. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newUserCode(): string {
  const chars = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Accepts "k7qx82md", "K7QX 82MD", "K7QX-82MD" … and returns "K7QX-82MD", or undefined. */
export function normalizeUserCode(input: string): string | undefined {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 8 || [...clean].some((ch) => !CODE_ALPHABET.includes(ch))) return undefined;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

const StartBody = z.strictObject({
  machine_name: MachineName,
  os: z.enum(["windows", "linux", "darwin"]),
  arch: z.enum(["amd64", "arm64"]),
  agent_version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  sync_interval_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
});

/** POST /agent/pair/start */
export async function startPairing(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, StartBody);
  const db = c.env.DB;
  const ip = clientIp(c.req.raw.headers);
  const limit = { key: `pair:${ip}`, ...STARTS_PER_IP };
  const wait = await retryAfter(db, [limit]);
  if (wait > 0) {
    fail(429, "too_many_requests", { retry_after_seconds: wait }, { "retry-after": String(wait) });
  }

  const now = Date.now();
  const pending = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM pairing_requests WHERE status = 'pending' AND expires_at > ?1",
    )
    .bind(now)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING) fail(429, "too_many_pending");

  const deviceCode = randomToken(32);
  let userCode = newUserCode();
  // Codes are random; a clash with another pending request is astronomically
  // unlikely, but cheap to rule out.
  while (
    await db
      .prepare("SELECT 1 FROM pairing_requests WHERE user_code = ?1 AND status = 'pending'")
      .bind(userCode)
      .first()
  ) {
    userCode = newUserCode();
  }

  await db.batch([
    db
      .prepare(
        "DELETE FROM pairing_requests WHERE expires_at < ?1 AND status IN ('pending', 'denied')",
      )
      .bind(now - 24 * 60 * 60 * 1000),
    db
      .prepare(
        `INSERT INTO pairing_requests (id, device_code_hash, user_code, machine_name, os, arch,
                                       agent_version, sync_interval_minutes, client_ip,
                                       created_at, expires_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending')`,
      )
      .bind(
        crypto.randomUUID(),
        await sha256Hex(deviceCode),
        userCode,
        body.machine_name,
        body.os,
        body.arch,
        body.agent_version,
        body.sync_interval_minutes,
        ip,
        now,
        now + PAIRING_TTL_MS,
      ),
    recordFailure(db, limit, now),
  ]);

  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_url: `${new URL(c.req.url).origin}/approve`,
    expires_in: PAIRING_TTL_MS / 1000,
    interval: POLL_INTERVAL_SECONDS,
  });
}

interface PairingRow {
  id: string;
  machine_name: string;
  os: string;
  arch: string;
  agent_version: string;
  sync_interval_minutes: number;
  expires_at: number;
  status: "pending" | "approved" | "denied" | "claimed";
  department_id: string | null;
  owner_id: string | null;
}

/** POST /agent/pair/poll — the machine asks whether it was approved yet. */
export async function pollPairing(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ device_code: z.string().min(1).max(128) }));
  const db = c.env.DB;
  const req = await db
    .prepare(
      `SELECT id, machine_name, os, arch, agent_version, sync_interval_minutes, expires_at, status,
              department_id, owner_id
         FROM pairing_requests WHERE device_code_hash = ?1`,
    )
    .bind(await sha256Hex(body.device_code))
    .first<PairingRow>();
  if (!req) fail(404, "not_found");

  const now = Date.now();
  if (req.status === "pending") {
    return c.json({ status: req.expires_at > now ? "pending" : "expired" });
  }
  if (req.status === "denied") return c.json({ status: "denied" });
  if (req.status === "claimed") return c.json({ status: "expired" });

  // Approved: hand out the upload key exactly once.
  const claimed = await db
    .prepare("UPDATE pairing_requests SET status = 'claimed' WHERE id = ?1 AND status = 'approved'")
    .bind(req.id)
    .run();
  if (claimed.meta.changes !== 1) return c.json({ status: "expired" });

  const token = `ccu_m_${randomToken(32)}`;
  const machineId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO machines (id, name, os, arch, agent_version, sync_interval_minutes, token_hash,
                               created_at, department_id, owner_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        machineId,
        req.machine_name,
        req.os,
        req.arch,
        req.agent_version,
        req.sync_interval_minutes,
        await sha256Hex(token),
        now,
        req.department_id,
        req.owner_id,
      ),
    db.prepare("UPDATE pairing_requests SET machine_id = ?1 WHERE id = ?2").bind(machineId, req.id),
  ]);
  const settings = await getSettings(db);
  return c.json({
    status: "approved",
    token,
    machine: { id: machineId, name: req.machine_name },
    timezone: settings.timezone,
  });
}
