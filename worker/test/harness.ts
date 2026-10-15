import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../build.mjs";

let bundled: Promise<string> | undefined;

const migrationsDir = join(import.meta.dirname, "../migrations");

/**
 * Splits a migration file into statements: a statement ends with a semicolon
 * at the end of a line. The Go setup wizard splits files the same way.
 */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const ORIGIN = "http://localhost";

/** A random login key, as a browser would derive from a password. */
export const newLoginKey = () => randomBytes(32).toString("base64url");

/** The server's stored form of a login key, computed independently of the Worker's code. */
export function serverHash(loginKey: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(Buffer.from(loginKey, "base64url"), salt, 5000, 32, "sha256");
  return `v1$5000$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export interface TestUser {
  id: string;
  username: string;
  key: string;
  cookie: string;
}

export interface TestWorker {
  mf: Miniflare;
  db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  fetch(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  sql(query: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  /** Applies one migration file, as `ccunified server update` would. */
  migrate(file: string): Promise<void>;
  createUser(opts?: {
    /** A dashboard-wide role (default admin), or null for none. */
    role?: "admin" | "viewer" | null;
    /** Roles in departments. */
    departments?: { id: string; role: "manager" | "viewer" | "member" }[];
    username?: string;
    key?: string;
    mustChangePassword?: boolean;
  }): Promise<TestUser>;
  login(username: string, key: string, code?: string): Promise<Response>;
  createDepartment(name: string): Promise<string>;
  createMachine(opts?: {
    name?: string;
    department?: string | null;
    owner?: string | null;
  }): Promise<{ id: string; token: string }>;
  dispose(): Promise<void>;
}

/**
 * Starts the bundled Worker in workerd (Cloudflare's runtime) with a fresh,
 * migrated D1 database. `outbound` answers every request the Worker makes to
 * other sites (such as GitHub); without it, those requests fail.
 */
export async function startWorker(
  options: {
    version?: string;
    outbound?: (request: Request) => Response | Promise<Response>;
    /** Apply only the migrations up to this file name (for testing a later one). */
    migrateUntil?: string;
  } = {},
): Promise<TestWorker> {
  const version = options.version ?? "test";
  let build: Promise<string>;
  if (version === "test") {
    bundled ??= bundleWorker({ version });
    build = bundled;
  } else {
    build = bundleWorker({ version });
  }
  const contents = await build;
  const outbound = options.outbound ?? (() => new Response("no network in tests", { status: 502 }));
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "ccunified-test",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: { DB: { type: "d1", id: `test-${randomUUID()}` } },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: (request) => outbound(request as unknown as Request) as never,
          },
        },
      },
    ],
  });
  await mf.ready;
  const db = await mf.getD1Database("DB");

  const migrate = async (file: string) => {
    const statements = splitSql(readFileSync(join(migrationsDir, file), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  };
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (options.migrateUntil && file > options.migrateUntil) break;
    await migrate(file);
  }

  const worker: TestWorker = {
    mf,
    db,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set("cookie", init.cookie);
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) {
        headers.set("origin", ORIGIN);
      }
      const res = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        ...(init as object),
        headers: Object.fromEntries(headers),
      });
      return res as unknown as Response;
    },
    migrate,
    async sql(query, ...params) {
      const { results } = await db
        .prepare(query)
        .bind(...params)
        .all();
      return results as Record<string, unknown>[];
    },
    async createUser(opts = {}) {
      const id = randomUUID();
      const now = Date.now();
      const token = randomBytes(32).toString("base64url");
      const username = opts.username ?? `user-${id.slice(0, 8)}`;
      const key = opts.key ?? newLoginKey();
      await db.batch([
        db
          .prepare(
            `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, password_changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
          )
          .bind(
            id,
            username,
            serverHash(key),
            opts.role === undefined ? "admin" : opts.role,
            opts.mustChangePassword ? 1 : 0,
            now,
          ),
        db
          .prepare(
            "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)",
          )
          .bind(sha256Hex(token), id, now, now + 86_400_000),
        ...(opts.departments ?? []).map((d) =>
          db
            .prepare(
              "INSERT INTO department_roles (department_id, user_id, role) VALUES (?1, ?2, ?3)",
            )
            .bind(d.id, id, d.role),
        ),
      ]);
      return { id, username, key, cookie: `__Host-ccu_session=${token}` };
    },
    async createDepartment(name) {
      const id = randomUUID();
      await db
        .prepare("INSERT INTO departments (id, name, created_at) VALUES (?1, ?2, ?3)")
        .bind(id, name, Date.now())
        .run();
      return id;
    },
    login(username, key, code) {
      return worker.fetch(
        "/api/login",
        jsonInit("POST", code ? { username, key, code } : { username, key }),
      );
    },
    async createMachine(opts = {}) {
      const id = randomUUID();
      const token = `ccu_m_${randomBytes(32).toString("base64url")}`;
      await db
        .prepare(
          `INSERT INTO machines (id, name, os, arch, agent_version, sync_interval_minutes, token_hash, created_at)
           VALUES (?1, ?2, 'linux', 'amd64', '0.1.0', 30, ?3, ?4)`,
        )
        .bind(id, opts.name ?? `machine-${id.slice(0, 8)}`, sha256Hex(token), Date.now())
        .run();
      if (opts.department || opts.owner) {
        await db
          .prepare("UPDATE machines SET department_id = ?1, owner_id = ?2 WHERE id = ?3")
          .bind(opts.department ?? null, opts.owner ?? null, id)
          .run();
      }
      return { id, token };
    },
    dispose: () => mf.dispose(),
  };
  return worker;
}

/** A valid upload payload, customisable per test. */
export function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    agent: {
      version: "0.1.0",
      os: "windows",
      arch: "amd64",
      ccusage_version: "20.0.31",
      sync_interval_minutes: 30,
    },
    timezone: "UTC",
    range: { from: "2026-10-07", to: "2026-10-13" },
    days: [
      {
        date: "2026-10-12",
        source: "claude",
        models: [
          {
            model: "claude-opus-5-5",
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_tokens: 300,
            cache_read_tokens: 400,
            cost_usd: 1.5,
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function jsonInit(method: string, body: unknown, extra: RequestInit = {}): RequestInit {
  return {
    method,
    ...extra,
    headers: { "content-type": "application/json", ...(extra.headers as object) },
    body: JSON.stringify(body),
  };
}
