import type { Context } from "hono";
import { z } from "zod";
import { normalizeUserCode } from "../agent/pair";
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

/** POST /api/pairing/approve (admin) — `{ user_code, name? }`; `name` overrides the machine's suggestion. */
export async function approvePairing(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(
    c,
    z.strictObject({ user_code: z.string().max(32), name: MachineName.optional() }),
  );
  const req = await findPending(c, body.user_code);
  const name = body.name ?? req.machine_name;
  if (await nameTaken(c.env.DB, name)) fail(409, "name_taken", { name });
  const res = await c.env.DB.prepare(
    `UPDATE pairing_requests
        SET status = 'approved', machine_name = ?1, decided_by = ?2, decided_at = ?3
      WHERE id = ?4 AND status = 'pending'`,
  )
    .bind(name, c.get("user").id, Date.now(), req.id)
    .run();
  if (res.meta.changes !== 1) fail(404, "not_found");
  return c.json({ ok: true, name });
}

/** POST /api/pairing/deny (admin) — `{ user_code }` */
export async function denyPairing(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ user_code: z.string().max(32) }));
  const req = await findPending(c, body.user_code);
  await c.env.DB.prepare(
    "UPDATE pairing_requests SET status = 'denied', decided_by = ?1, decided_at = ?2 WHERE id = ?3",
  )
    .bind(c.get("user").id, Date.now(), req.id)
    .run();
  return c.json({ ok: true });
}
