import type { MiddlewareHandler } from "hono";
import type { AppEnv, MachineRow } from "../env";
import { sha256Hex } from "../lib/crypto";
import { fail } from "../lib/http";

/** Machine upload keys look like `ccu_m_` followed by 43 base64url characters. */
export const MACHINE_TOKEN_RE = /^ccu_m_[A-Za-z0-9_-]{43}$/;

/** Authenticates a machine by its upload key (`Authorization: Bearer ccu_m_...`). */
export const machineAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!MACHINE_TOKEN_RE.test(token)) {
    fail(401, "invalid_token", {}, { "www-authenticate": "Bearer" });
  }
  const machine = await c.env.DB.prepare(
    "SELECT id, name, last_seen_at, revoked_at, tools FROM machines WHERE token_hash = ?1",
  )
    .bind(await sha256Hex(token))
    .first<MachineRow>();
  if (!machine) fail(401, "invalid_token", {}, { "www-authenticate": "Bearer" });
  if (machine.revoked_at !== null) fail(401, "machine_revoked");
  c.set("machine", machine);
  await next();
};
