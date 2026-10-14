export interface Env {
  DB: D1Database;
}

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "viewer";
  totpEnabled: boolean;
  sessionHash: string;
}

export interface MachineRow {
  id: string;
  name: string;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    machine: MachineRow;
  };
};
