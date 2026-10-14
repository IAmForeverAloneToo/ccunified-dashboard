import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { compareVersions } from "../lib/semver";
import { getSettings, parseList } from "../lib/settings";
import { latestVersion } from "../lib/updates";

/** Machine names: 1–64 printable characters, no control characters. */
export const MachineName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}]+$/u, "no control characters");

interface MachineDbRow {
  id: string;
  name: string;
  os: string;
  arch: string;
  agent_version: string;
  ccusage_version: string | null;
  sync_interval_minutes: number;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  tools: string;
}

/** A machine is "late" once it misses two syncs plus ten minutes of slack. */
export function machineStatus(m: MachineDbRow, now = Date.now()): string {
  if (m.revoked_at !== null) return "revoked";
  if (m.last_seen_at === null) return "never";
  const late = m.last_seen_at < now - (2 * m.sync_interval_minutes + 10) * 60_000;
  return late ? "late" : "ok";
}

/** GET /api/machines */
export async function listMachines(c: Context<AppEnv>): Promise<Response> {
  const [settings, { results }] = await Promise.all([
    getSettings(c.env.DB),
    c.env.DB.prepare(
      `SELECT id, name, os, arch, agent_version, ccusage_version, sync_interval_minutes,
              created_at, last_seen_at, revoked_at, tools
         FROM machines
        ORDER BY revoked_at IS NOT NULL, name COLLATE NOCASE`,
    ).all<MachineDbRow>(),
  ]);
  const latest = latestVersion(c.env.DB, settings, c.executionCtx);
  const now = Date.now();
  return c.json({
    latest_version: latest,
    machines: results.map((m) => ({
      ...m,
      tools: parseList(m.tools),
      status: machineStatus(m, now),
      update_available: latest !== null && (compareVersions(m.agent_version, latest) ?? 0) < 0,
    })),
  });
}

export async function nameTaken(db: D1Database, name: string, exceptId?: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM machines WHERE name = ?1 COLLATE NOCASE AND revoked_at IS NULL AND id IS NOT ?2",
    )
    .bind(name, exceptId ?? null)
    .first();
  return row !== null;
}

/** PATCH /api/machines/:id — rename (admin). */
export async function renameMachine(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const { name } = await readJson(c, z.strictObject({ name: MachineName }));
  if (await nameTaken(c.env.DB, name, id)) fail(409, "name_taken");
  const res = await c.env.DB.prepare("UPDATE machines SET name = ?1 WHERE id = ?2")
    .bind(name, id)
    .run();
  if (res.meta.changes === 0) fail(404, "not_found");
  return c.json({ ok: true });
}

/** DELETE /api/machines/:id — revoke the machine's upload key; its history is kept (admin). */
export async function revokeMachine(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const res = await c.env.DB.prepare(
    "UPDATE machines SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
  )
    .bind(Date.now(), id)
    .run();
  if (res.meta.changes === 0) fail(404, "not_found");
  return c.json({ ok: true });
}
