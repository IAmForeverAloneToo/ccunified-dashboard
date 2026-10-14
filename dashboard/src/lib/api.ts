// Typed access to the Worker's /api endpoints.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(code);
  }
}

type Listener = (error: ApiError) => void;
const authListeners: Listener[] = [];

/** Called when a request finds the session missing or a password change pending. */
export function onAuthProblem(listener: Listener): void {
  authListeners.push(listener);
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; quietAuth?: boolean } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  };
  if (options.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON error (e.g. a proxy page); fall through with an empty body.
  }
  if (!res.ok) {
    const error = new ApiError(res.status, String(data.error ?? `http_${res.status}`), data);
    const authProblem =
      res.status === 401 && error.code === "not_logged_in"
        ? true
        : res.status === 403 && error.code === "password_change_required";
    if (authProblem && !options.quietAuth) {
      for (const l of authListeners) l(error);
    }
    throw error;
  }
  return data as T;
}

/** GET with an ETag: returns the cached copy when the server says nothing changed. */
const etagCache = new Map<string, { etag: string; data: unknown }>();

export async function getCached<T>(path: string): Promise<T> {
  const cached = etagCache.get(path);
  const res = await fetch(`/api${path}`, {
    headers: cached ? { "if-none-match": cached.etag, accept: "application/json" } : {},
    credentials: "same-origin",
  });
  if (res.status === 304 && cached) return cached.data as T;
  if (!res.ok) {
    // Re-run through api() for consistent error handling.
    return api<T>(path);
  }
  const data = (await res.json()) as T;
  const etag = res.headers.get("etag");
  if (etag) etagCache.set(path, { etag, data });
  return data;
}

export interface Me {
  id: string;
  username: string;
  role: "admin" | "viewer";
  totp_enabled: boolean;
  must_change_password: boolean;
}

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface Summary {
  timezone: string;
  today: string;
  from: string;
  to: string;
  /** Every tool the dashboard has seen, in the order they first appeared. */
  tools: string[];
  by_day_machine: (Totals & { day: string; machine_id: string })[];
  by_day_model: (Totals & { day: string; model: string })[];
  by_day_source: (Totals & { day: string; source: string })[];
  /** Each machine's usage per tool over the whole period. */
  by_machine_source: (Totals & { machine_id: string; source: string })[];
}

export interface Machine {
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
  /** The tools this machine has reported usage for. */
  tools: string[];
  status: "ok" | "late" | "never" | "revoked";
  update_available: boolean;
}

export interface MachinesResponse {
  latest_version: string | null;
  machines: Machine[];
}

export interface PairingRequest {
  id: string;
  user_code: string;
  machine_name: string;
  os: string;
  arch: string;
  agent_version: string;
  client_ip: string | null;
  created_at: number;
  expires_at: number;
}

export interface User {
  id: string;
  username: string;
  role: "admin" | "viewer";
  totp_enabled: boolean;
  must_change_password: boolean;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
}

export interface SettingsResponse {
  timezone: string;
  server_version: string;
  latest_version: string | null;
  /** When the dashboard last asked GitHub for the newest release (null: not yet). */
  latest_checked_at: number | null;
  /** Why that check failed; null if it worked. */
  latest_check_error: string | null;
  source_repo: string;
}
