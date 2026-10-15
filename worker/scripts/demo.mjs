// Runs the Worker locally with a throwaway database full of sample data, for
// trying the dashboard and for screenshots:
//
//   npm run build -w dashboard && node worker/scripts/demo.mjs [port]
//
// Log in as "demo" with password "demo-password" (an admin). Others show
// what each role sees: "sam" (viewer of everything), "morgan" (manager of
// Engineering), "riley" and "jordan" (members), "casey" (viewer of Design);
// each one's password is "<name>-password". Nothing is saved.
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8787);

const splitSql = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((x) => x.trim())
    .filter(Boolean);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function loginKey(installId, username, password) {
  const salt = createHash("sha256")
    .update(`ccunified-login-v1|${installId}|${username.toLowerCase()}`)
    .digest();
  return pbkdf2Sync(Buffer.from(password.normalize("NFC")), salt, 600_000, 32, "sha256");
}

const DEMO_VERSION = "0.1.0-demo";

/**
 * A stand-in for GitHub, so the demo never contacts it. By default the demo's
 * own version is the newest release; tests change `latest` and `reachable`.
 */
function fakeGitHub(github) {
  return (request) => {
    const url = new URL(request.url);
    if (!github.reachable) return new Response("unavailable", { status: 503 });
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/releases/latest")) {
      return Response.json({ tag_name: `v${github.latest}` });
    }
    if (url.hostname === "github.com" && url.pathname.endsWith("/releases/latest")) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://github.com${url.pathname.replace(/latest$/, `tag/v${github.latest}`)}`,
        },
      });
    }
    return new Response("not part of the demo", { status: 404 });
  };
}

function serverHash(key) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(key, salt, 5000, 32, "sha256");
  return `v1$5000$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function startDemo({ port: listenPort = port, seed = true, quiet = false } = {}) {
  const github = { latest: DEMO_VERSION, reachable: true };
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: listenPort,
    workers: [
      {
        config: {
          name: "ccunified-demo",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: await bundleWorker({ version: DEMO_VERSION, requireDashboard: true }),
              },
            },
          },
          env: { DB: { type: "d1", id: `demo-${randomUUID()}` } },
        },
        dev: { outboundService: { type: "fetcher", handler: fakeGitHub(github) } },
      },
    ],
  });
  const url = await mf.ready;
  const db = await mf.getD1Database("DB");
  const migrations = join(here, "../migrations");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.batch(
      splitSql(readFileSync(join(migrations, file), "utf8")).map((s) => db.prepare(s)),
    );
  }
  if (seed) await seedDemo(db);
  if (!quiet) {
    console.log(`ccunified demo running at ${url}`);
    console.log('Log in as "demo" with password "demo-password". Ctrl+C to stop.');
    console.log('Other roles: sam, morgan, riley, jordan, casey (password "<name>-password").');
  }
  return { mf, url: String(url), db, github };
}

async function seedDemo(db) {
  const now = Date.now();
  const { value: installId } = await db
    .prepare("SELECT value FROM settings WHERE key = 'install_id'")
    .first();
  await db.prepare("UPDATE settings SET value = 'America/Toronto' WHERE key = 'timezone'").run();

  // Two departments, and people in each role. Everyone's password is
  // "<name>-password".
  const departments = { Engineering: randomUUID(), Design: randomUUID() };
  for (const [name, id] of Object.entries(departments)) {
    await db
      .prepare("INSERT INTO departments (id, name, created_at) VALUES (?1, ?2, ?3)")
      .bind(id, name, now - 50 * 864e5 + name.length)
      .run();
  }
  const users = [
    ["demo", "admin", []],
    ["sam", "viewer", []],
    ["morgan", null, [["Engineering", "manager"]]],
    ["riley", null, [["Engineering", "member"]]],
    ["jordan", null, [["Design", "member"]]],
    ["casey", null, [["Design", "viewer"]]],
  ];
  const userIds = {};
  for (const [name, role, roles] of users) {
    const id = randomUUID();
    userIds[name] = id;
    await db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
      )
      .bind(
        id,
        name,
        serverHash(loginKey(installId, name, `${name}-password`)),
        role,
        now - 40 * 864e5,
        now - 3600e3,
      )
      .run();
    for (const [department, departmentRole] of roles) {
      await db
        .prepare("INSERT INTO department_roles (department_id, user_id, role) VALUES (?1, ?2, ?3)")
        .bind(departments[department], id, departmentRole)
        .run();
    }
  }

  // Each tool's models: [name, share of the day's usage, input price per million tokens].
  const claude = [
    ["claude-opus-5-5", 1.0, 15],
    ["claude-sonnet-5-5", 0.6, 3],
    ["claude-haiku-5-5", 0.25, 0.8],
    ["claude-mythos-5-1", 0.08, 25],
  ];
  const codex = [["gpt-5.5", 0.5, 1.25]];
  const gemini = [
    ["gemini-3-pro", 0.45, 2],
    ["gemini-3-flash", 0.15, 0.3],
  ];
  const opencode = [["anthropic/claude-sonnet-5-5", 0.35, 3]];
  const kimi = [["k3", 0.3, 3]];
  const machines = [
    {
      name: "Office PC",
      os: "windows",
      scale: 1.0,
      seen: now - 4 * 60e3,
      interval: 30,
      created: 90,
      tools: { claude, codex },
      department: "Engineering",
      owner: "riley",
    },
    {
      name: "Laptop",
      os: "windows",
      scale: 0.55,
      seen: now - 12 * 60e3,
      interval: 15,
      created: 80,
      tools: { claude, gemini },
      department: "Design",
      owner: "jordan",
    },
    {
      name: "Build server",
      os: "linux",
      scale: 0.8,
      seen: now - 3 * 3600e3,
      interval: 30,
      created: 60,
      version: "0.0.9",
      tools: { claude },
      department: "Engineering",
    },
    {
      name: "Home PC",
      os: "windows",
      scale: 0.3,
      seen: now - 25 * 60e3,
      interval: 60,
      created: 20,
      tools: { claude, opencode, kimi },
    },
  ];
  // The order the dashboard first saw each tool in, which sets their colors.
  await db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'tools'")
    .bind(JSON.stringify(["claude", "codex", "gemini", "opencode", "kimi"]))
    .run();
  let seedValue = 42;
  const rand = () => {
    seedValue = (seedValue * 1664525 + 1013904223) % 2 ** 32;
    return seedValue / 2 ** 32;
  };
  const today = new Date(now - 4 * 3600e3).toISOString().slice(0, 10);
  // Days (counted back from today) with no usage anywhere, as on a holiday.
  const daysOff = new Set([9, 23, 24, 47]);
  for (const m of machines) {
    const id = randomUUID();
    await db
      .prepare(
        "INSERT INTO machines (id, name, os, arch, agent_version, ccusage_version, sync_interval_minutes, token_hash, created_at, last_seen_at, tools, department_id, owner_id) VALUES (?1, ?2, ?3, 'amd64', ?4, '20.0.32', ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      )
      .bind(
        id,
        m.name,
        m.os,
        m.version ?? DEMO_VERSION,
        m.interval,
        sha256(randomUUID()),
        now - m.created * 864e5,
        m.seen,
        JSON.stringify(Object.keys(m.tools)),
        m.department ? departments[m.department] : null,
        m.owner ? userIds[m.owner] : null,
      )
      .run();
    const rows = [];
    for (let d = 0; d < m.created; d++) {
      const date = new Date(Date.parse(`${today}T00:00:00Z`) - d * 864e5);
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      if (daysOff.has(d) || rand() < (weekend ? 0.6 : 0.08)) continue;
      for (const [source, models] of Object.entries(m.tools)) {
        for (const [model, share, price] of models) {
          if (rand() < 0.25 && share < 1) continue;
          const base = m.scale * share * (weekend ? 0.4 : 1) * (0.5 + rand());
          const input = Math.round(40_000 * base);
          const output = Math.round(180_000 * base);
          // Codex and Gemini CLI don't report cache writes.
          const cacheCreate =
            source === "claude" || source === "opencode" ? Math.round(1_400_000 * base) : 0;
          const cacheRead = Math.round(22_000_000 * base);
          const cost =
            (input * price +
              output * price * 5 +
              cacheCreate * price * 1.25 +
              cacheRead * price * 0.1) /
            1e6;
          rows.push(
            db
              .prepare(
                "INSERT INTO usage_daily (machine_id, source, day, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
              )
              .bind(
                id,
                source,
                date.toISOString().slice(0, 10),
                model,
                input,
                output,
                cacheCreate,
                cacheRead,
                cost,
                now,
              ),
          );
        }
      }
    }
    for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
  }
  // Every model in the order it first appeared, as uploads record it.
  await db
    .prepare(
      "UPDATE settings SET value = (SELECT json_group_array(model) FROM (SELECT model FROM usage_daily GROUP BY model ORDER BY MIN(day), model)) WHERE key = 'models'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO pairing_requests (id, device_code_hash, user_code, machine_name, os, arch, agent_version, sync_interval_minutes, client_ip, created_at, expires_at, status) VALUES (?1, ?2, 'K7QX-82MD', 'Studio PC', 'windows', 'amd64', '0.1.0-demo', 30, '203.0.113.24', ?3, ?4, 'pending')",
    )
    .bind(randomUUID(), sha256(randomUUID()), now - 60e3, now + 9 * 60e3)
    .run();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mf } = await startDemo();
  const stop = async () => {
    await mf.dispose();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
