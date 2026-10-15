export interface Env {
  DB: D1Database;
}

/** A dashboard-wide role: admins manage everything, viewers see everything. */
export type DashboardRole = "admin" | "viewer";

/**
 * A role in one department: managers see and manage its machines and plain
 * users, viewers see its machines, members can own its machines.
 */
export type DepartmentRole = "manager" | "viewer" | "member";

export interface SessionUser {
  id: string;
  username: string;
  /** Null for people who only have roles in some departments. */
  role: DashboardRole | null;
  /** The user's role in each department they have one in, by department id. */
  departments: Map<string, DepartmentRole>;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  sessionHash: string;
}

export interface MachineRow {
  id: string;
  name: string;
  last_seen_at: number | null;
  revoked_at: number | null;
  /** JSON array of the tools this machine has reported usage for. */
  tools: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    machine: MachineRow;
  };
};
