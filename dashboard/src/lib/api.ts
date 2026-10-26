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

/** Admins see and manage everything; viewers see everything. */
export type DashboardRole = "admin" | "viewer";

/** Managers see and manage a department; viewers see it; members can own its machines. */
export type DepartmentRole = "manager" | "viewer" | "member";

export interface Me {
  id: string;
  username: string;
  /** Null for people with only department roles. */
  role: DashboardRole | null;
  departments: { id: string; name: string; role: DepartmentRole }[];
  totp_enabled: boolean;
  must_change_password: boolean;
}

export interface Department {
  id: string;
  name: string;
  created_at: number;
  /** Machines in it (not counting revoked ones). */
  machines: number;
  /** People with a role in it. */
  people: number;
  /** The logged-in user's role in it. */
  my_role: DepartmentRole | null;
}

export interface User {
  id: string;
  username: string;
  role: DashboardRole | null;
  /** Their roles (for managers: only in the departments they manage). */
  departments: { id: string; role: DepartmentRole }[];
  totp_enabled: boolean;
  must_change_password: boolean;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
  /** Whether the logged-in user can change this user. */
  can_manage: boolean;
}

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/** A step of the Overview's chart: a day, a week (from Monday) or a month. */
export type Bucket = "day" | "week" | "month";

interface SummaryHead {
  timezone: string;
  today: string;
  from: string;
  to: string;
  /** Every tool the dashboard has seen, in the order they first appeared. */
  tools: string[];
  /** Every model the dashboard has seen, in the order they first appeared. */
  models: string[];
  /** How costs are worked out, and where each model's price came from. */
  pricing?: { mode: PricingMode; sources: Record<string, PriceSource> };
}

/**
 * How costs are worked out: as each machine's ccusage reported them, from the
 * public price lists, or from custom prices (see worker/src/lib/pricing.ts).
 */
export type PricingMode = "ccusage" | "lists" | "custom";
export type PriceSource = "ccusage" | "custom" | "models.dev" | "litellm";

/** A price in US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface PricesResponse {
  mode: PricingMode;
  models: {
    model: string;
    custom: Price | null;
    models_dev: (Price & { entry: string }) | null;
    litellm: (Price & { entry: string }) | null;
  }[];
}

export interface Summary extends SummaryHead {
  /** What each `day` stands for: the day itself, or the first day of its week or month. */
  bucket?: Bucket;
  by_day_machine: (Totals & { day: string; machine_id: string })[];
  by_day_model: (Totals & { day: string; model: string })[];
  by_day_source: (Totals & { day: string; source: string })[];
  /** Each machine's usage per tool over the whole period. */
  by_machine_source: (Totals & { machine_id: string; source: string })[];
}

/** The answer to /summary?detail=1: the rows themselves, totaled and filtered in the browser (see filters.ts). */
export interface DetailedSummary extends SummaryHead {
  /** Over 92 days the rows are per week, and over two years per month. */
  bucket: Bucket;
  detail: SummaryDetail;
}

/** Rows of usage: [day, machine, tool, model, input, output, cache write, cache read, cost]; the first four index the lists. */
export interface SummaryDetail {
  days: string[];
  machines: string[];
  sources: string[];
  models: string[];
  rows: [number, number, number, number, number, number, number, number, number][];
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
  department: { id: string; name: string } | null;
  /** Null for a shared machine. */
  owner: { id: string; username: string } | null;
  status: "ok" | "late" | "never" | "revoked";
  update_available: boolean;
  /** Whether the logged-in user can rename, move, revoke it and pick its owner. */
  can_manage: boolean;
}

export interface MachinesResponse {
  latest_version: string | null;
  /** The GitHub repository releases come from, for install commands. */
  source_repo: string;
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
