// What the logged-in person can do, for showing only the pages and buttons
// that work for them. The Worker enforces the same rules (auth/access.ts).
import type { DepartmentRole, Me } from "./api";

export const isAdmin = (me: Me) => me.role === "admin";

/** Admins and dashboard-wide viewers see every machine and the Settings page. */
export const seesAll = (me: Me) => me.role === "admin" || me.role === "viewer";

/** The departments the person manages. */
export const managedDepartments = (me: Me) => me.departments.filter((d) => d.role === "manager");

/** Admins and managers: approve machines and manage users. */
export const managesSomething = (me: Me) => isAdmin(me) || managedDepartments(me).length > 0;

export const DEPARTMENT_ROLE_LABEL: Record<DepartmentRole, string> = {
  manager: "Manager",
  viewer: "Viewer",
  member: "Member",
};

/** How to describe someone's access, such as "Admin" or "Manager of Design · Member of Sales". */
export function describeAccess(
  role: Me["role"],
  departments: { name: string; role: DepartmentRole }[],
): string {
  const parts: string[] = [];
  if (role === "admin") parts.push("Admin");
  if (role === "viewer") parts.push("Viewer of everything");
  for (const d of departments) parts.push(`${DEPARTMENT_ROLE_LABEL[d.role]} of ${d.name}`);
  return parts.join(" · ") || "No access yet";
}
