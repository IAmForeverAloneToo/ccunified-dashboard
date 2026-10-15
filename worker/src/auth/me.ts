import type { Context } from "hono";
import type { AppEnv } from "../env";

/**
 * GET /api/me — the logged-in user: their dashboard-wide role (or null) and
 * their role in each department, which the dashboard uses to show what they
 * can do.
 */
export async function me(c: Context<AppEnv>): Promise<Response> {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, r.role FROM department_roles r JOIN departments d ON d.id = r.department_id
      WHERE r.user_id = ?1 ORDER BY d.name COLLATE NOCASE`,
  )
    .bind(u.id)
    .all<{ id: string; name: string; role: string }>();
  return c.json({
    id: u.id,
    username: u.username,
    role: u.role,
    departments: results,
    totp_enabled: u.totpEnabled,
    must_change_password: u.mustChangePassword,
  });
}
