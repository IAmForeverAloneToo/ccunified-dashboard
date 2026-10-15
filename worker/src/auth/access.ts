// Who sees and manages what.
//
// Dashboard-wide roles: admins see and manage everything; viewers see
// everything. Department roles: managers see their departments' machines and
// manage them and their plain users; department viewers see their
// departments' machines; members can own machines there. Everyone sees the
// machines they own.
import type { DepartmentRole, SessionUser } from "../env";
import { sha256Hex } from "../lib/crypto";
import { fail } from "../lib/http";

export const isAdmin = (u: SessionUser) => u.role === "admin";

/** Admins and dashboard-wide viewers see every machine. */
export const seesAll = (u: SessionUser) => u.role === "admin" || u.role === "viewer";

/** The departments where the user has one of the given roles. */
export function departmentsWith(u: SessionUser, ...roles: DepartmentRole[]): string[] {
  return [...u.departments].filter(([, r]) => roles.includes(r)).map(([id]) => id);
}

/** Admins, and managers of any department. */
export const managesSomething = (u: SessionUser) =>
  isAdmin(u) || departmentsWith(u, "manager").length > 0;

/** Whether the user manages machines and plain users in a department (admins: every one). */
export const manages = (u: SessionUser, departmentId: string | null) =>
  isAdmin(u) || (departmentId !== null && u.departments.get(departmentId) === "manager");

/**
 * The ids of the machines the user can see, or null for every machine. Its
 * `key` changes whenever the set does, for cache validators.
 */
export async function visibleMachines(
  db: D1Database,
  u: SessionUser,
): Promise<{ ids: string[] | null; key: string }> {
  if (seesAll(u)) return { ids: null, key: "all" };
  const { results } = await db
    .prepare(
      `SELECT id FROM machines
        WHERE owner_id = ?1 OR department_id IN (SELECT value FROM json_each(?2))
        ORDER BY id`,
    )
    .bind(u.id, JSON.stringify(departmentsWith(u, "manager", "viewer")))
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  return { ids, key: (await sha256Hex(ids.join(","))).slice(0, 16) };
}

/** A SQL condition limiting rows to the user's machines (`column` holds the machine id). */
export function machineScopeSql(column: string, param: string, ids: string[] | null): string {
  return ids === null ? "" : `AND ${column} IN (SELECT value FROM json_each(${param}))`;
}

/**
 * A user that a manager may manage: no dashboard-wide role, a manager
 * nowhere, and only in departments this manager manages. Admins manage
 * everyone but themselves.
 */
export function canManageUser(
  u: SessionUser,
  target: { id: string; role: string | null; departments: Map<string, DepartmentRole> },
): boolean {
  if (target.id === u.id) return false;
  if (isAdmin(u)) return true;
  if (target.role !== null || target.departments.size === 0) return false;
  for (const [id, role] of target.departments) {
    if (role === "manager" || !manages(u, id)) return false;
  }
  return true;
}

/**
 * Checks that `ownerId` may own a machine in `departmentId`: someone with a
 * role there, or, for a machine without a department, anyone (admins only).
 */
export async function checkOwner(
  db: D1Database,
  u: SessionUser,
  departmentId: string | null,
  ownerId: string | null,
): Promise<void> {
  if (ownerId === null) return;
  const row = await db
    .prepare(
      `SELECT (SELECT 1 FROM users WHERE id = ?1) AS user,
              (SELECT 1 FROM department_roles WHERE user_id = ?1 AND department_id = ?2) AS member`,
    )
    .bind(ownerId, departmentId)
    .first<{ user: number | null; member: number | null }>();
  if (!row?.user) fail(400, "unknown_owner");
  if (departmentId === null ? !isAdmin(u) : !row.member) fail(409, "owner_not_in_department");
}

/** Checks that a department exists. */
export async function checkDepartment(db: D1Database, id: string): Promise<void> {
  const row = await db.prepare("SELECT 1 FROM departments WHERE id = ?1").bind(id).first();
  if (!row) fail(400, "unknown_department");
}
