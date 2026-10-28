import type { Context } from "hono";
import { z } from "zod";
import {
  checkDepartment,
  checkOwner,
  departmentsWith,
  isAdmin,
  manages,
  seesAll,
} from "../auth/access";
import type { AppEnv, SessionUser } from "../env";
import { fail, readJson } from "../lib/http";
import { compareVersions } from "../lib/semver";
import { bumpDataVersion, getSettings, parseList } from "../lib/settings";
import { latestVersion } from "../lib/updates";
import { SOURCE_REPO } from "../version";

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
  removed_at: number | null;
  tools: string;
  department_id: string | null;
  department_name: string | null;
  owner_id: string | null;
  owner_username: string | null;
}

/** A machine is "late" once it misses two syncs plus ten minutes of slack. */
export function machineStatus(
  m: Pick<MachineDbRow, "revoked_at" | "last_seen_at" | "sync_interval_minutes">,
  now = Date.now(),
): string {
  if (m.revoked_at !== null) return "revoked";
  if (m.last_seen_at === null) return "never";
  const late = m.last_seen_at < now - (2 * m.sync_interval_minutes + 10) * 60_000;
  return late ? "late" : "ok";
}

/**
 * GET /api/machines — the machines the user can see (see auth/access.ts),
 * each with its department, its owner, and whether the user manages it.
 * Removed machines whose usage was kept are listed too (with `removed_at`),
 * so the Overview can count their usage in their departments.
 */
export async function listMachines(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const [settings, { results }] = await Promise.all([
    getSettings(c.env.DB),
    c.env.DB.prepare(
      `SELECT m.id, m.name, m.os, m.arch, m.agent_version, m.ccusage_version,
              m.sync_interval_minutes, m.created_at, m.last_seen_at, m.revoked_at, m.removed_at, m.tools,
              m.department_id, d.name AS department_name, m.owner_id, o.username AS owner_username
         FROM machines m
         LEFT JOIN departments d ON d.id = m.department_id
         LEFT JOIN users o ON o.id = m.owner_id
        WHERE ?1 = 1 OR m.owner_id = ?2
           OR m.department_id IN (SELECT value FROM json_each(?3))
        ORDER BY m.revoked_at IS NOT NULL, m.name COLLATE NOCASE`,
    )
      .bind(seesAll(u) ? 1 : 0, u.id, JSON.stringify(departmentsWith(u, "manager", "viewer")))
      .all<MachineDbRow>(),
  ]);
  const latest = latestVersion(c.env.DB, settings, c.executionCtx);
  const now = Date.now();
  return c.json({
    latest_version: latest,
    /** Where releases come from, for the install commands. */
    source_repo: SOURCE_REPO,
    machines: results.map(({ department_name, owner_username, ...m }) => ({
      ...m,
      tools: parseList(m.tools),
      department: m.department_id ? { id: m.department_id, name: department_name } : null,
      owner: m.owner_id ? { id: m.owner_id, username: owner_username } : null,
      status: machineStatus(m, now),
      update_available: latest !== null && (compareVersions(m.agent_version, latest) ?? 0) < 0,
      can_manage: manages(u, m.department_id),
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

/**
 * The names in use: active machines, and machines waiting to join (lower
 * case), leaving out the waiting requests in `exceptRequests`.
 */
export async function takenNames(
  db: D1Database,
  exceptRequests: string[] = [],
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT name FROM machines WHERE revoked_at IS NULL
       UNION ALL
       SELECT machine_name FROM pairing_requests
        WHERE status IN ('pending', 'approved') AND expires_at > ?1
          AND id NOT IN (SELECT value FROM json_each(?2))`,
    )
    .bind(Date.now(), JSON.stringify(exceptRequests))
    .raw<[string]>();
  return new Set(rows.map(([n]) => n.toLowerCase()));
}

/** `name`, or the first of "name-2", "name-3"… that isn't taken (and fits in 64 characters). */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, 64 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Loads a machine the user manages: admins any, managers those in their
 * departments. A machine the user can't see is "not found"; one they see
 * but don't manage is "forbidden".
 */
async function managedMachine(c: Context<AppEnv>, u: SessionUser) {
  const id = c.req.param("id") ?? "";
  const m = await c.env.DB.prepare(
    "SELECT id, department_id, owner_id, revoked_at, removed_at FROM machines WHERE id = ?1",
  )
    .bind(id)
    .first<{
      id: string;
      department_id: string | null;
      owner_id: string | null;
      revoked_at: number | null;
      removed_at: number | null;
    }>();
  const visible =
    m !== null &&
    m.removed_at === null &&
    (seesAll(u) ||
      m.owner_id === u.id ||
      (m.department_id !== null &&
        departmentsWith(u, "manager", "viewer").includes(m.department_id)));
  if (!m || !visible) fail(404, "not_found");
  if (!manages(u, m.department_id)) fail(403, "forbidden");
  return m;
}

const MachineChange = z
  .strictObject({
    name: MachineName.optional(),
    department_id: z.string().max(64).nullable().optional(),
    owner_id: z.string().max(64).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

/**
 * PATCH /api/machines/:id — rename, move to another department, or change
 * the owner (admins, and managers of its department). Managers can move a
 * machine only between departments they manage. The owner must have a role
 * in the machine's department; machines without one (admins only) may be
 * owned by anyone.
 */
export async function updateMachine(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const body = await readJson(c, MachineChange);
  const m = await managedMachine(c, u);
  const db = c.env.DB;
  const department = body.department_id === undefined ? m.department_id : body.department_id;
  const owner = body.owner_id === undefined ? m.owner_id : body.owner_id;
  if (body.department_id !== undefined) {
    if (department === null ? !isAdmin(u) : !manages(u, department)) fail(403, "forbidden");
    if (department !== null) await checkDepartment(db, department);
  }
  if (body.department_id !== undefined || body.owner_id !== undefined) {
    await checkOwner(db, u, department, owner);
  }
  if (body.name !== undefined && (await nameTaken(db, body.name, m.id))) fail(409, "name_taken");
  await db
    .prepare(
      "UPDATE machines SET name = COALESCE(?1, name), department_id = ?2, owner_id = ?3 WHERE id = ?4",
    )
    .bind(body.name ?? null, department, owner, m.id)
    .run();
  return c.json({ ok: true });
}

/**
 * POST /api/machines/:id/revoke — revoke the machine's upload key; its
 * history is kept (admins, and managers of its department).
 */
export async function revokeMachine(c: Context<AppEnv>): Promise<Response> {
  const m = await managedMachine(c, c.get("user"));
  const res = await c.env.DB.prepare(
    "UPDATE machines SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
  )
    .bind(Date.now(), m.id)
    .run();
  if (res.meta.changes === 0) fail(404, "not_found");
  return c.json({ ok: true });
}

const RemoveQuery = z.object({ usage: z.enum(["keep", "delete"]) });

/**
 * DELETE /api/machines/:id?usage=keep|delete — remove a revoked machine from
 * the dashboard (admins, and managers of its department). With usage=keep its
 * usage stays in the totals, as "Removed machines"; with usage=delete the
 * machine and all its usage are deleted.
 */
export async function removeMachine(c: Context<AppEnv>): Promise<Response> {
  const query = RemoveQuery.safeParse(c.req.query());
  if (!query.success) fail(400, "invalid_request", { message: "usage must be keep or delete" });
  const m = await managedMachine(c, c.get("user"));
  if (m.revoked_at === null) fail(409, "not_revoked");
  const db = c.env.DB;
  if (query.data.usage === "keep") {
    await db
      .prepare("UPDATE machines SET removed_at = ?1 WHERE id = ?2")
      .bind(Date.now(), m.id)
      .run();
  } else {
    // Its usage rows go with it (ON DELETE CASCADE); dashboards refetch.
    await db.batch([
      db.prepare("DELETE FROM machines WHERE id = ?1").bind(m.id),
      bumpDataVersion(db),
    ]);
  }
  return c.json({ ok: true });
}
