// Sets ccunified up for every account on a Windows computer, as a deployment
// tool would, and checks that the scheduled task, running as SYSTEM, uploads
// this account's usage with ccusage running as this account, not as SYSTEM:
// the real program, Task Scheduler and ccusage, against a local dashboard
// (CI's Windows runners; needs an elevated window).
//
//   npm run build -w dashboard
//   node e2e/windows-all-users.mjs <folder with ccunified.exe and ccusage.exe>
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { startDemo } from "../worker/scripts/demo.mjs";

const bin = process.argv[2];
if (process.platform !== "win32" || !bin) {
  console.error("usage (on Windows, elevated): node e2e/windows-all-users.mjs <folder>");
  process.exit(2);
}
const exe = join(bin, "ccunified.exe");
const fail = (message) => {
  throw new Error(message);
};
const run = (args, env = {}) => {
  try {
    const out = execFileSync(exe, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    console.log(`$ ccunified ${args.join(" ")}\n${out}`);
    return out;
  } catch (e) {
    console.log(`$ ccunified ${args.join(" ")} (exit ${e.status})\n${e.stdout}${e.stderr}`);
    throw e;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The owner of a file or folder, like "BUILTIN\Administrators". */
const ownerOf = (path) =>
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", "(Get-Acl -LiteralPath $env:CCU_PATH).Owner"],
    {
      encoding: "utf8",
      // Without PowerShell 7's module path (CI's steps run in it), which
      // keeps Windows PowerShell from loading Get-Acl.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"),
        ),
        CCU_PATH: path,
      },
    },
  ).trim();
const filesIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
    : [];

// Where ccusage caches the prices it fetches, in this account's profile.
const cache = join(homedir(), ".cache", "ccusage");

// This account's Claude Code usage, where Claude Code keeps it.
const project = join(homedir(), ".claude", "projects", "C--ci-project");
mkdirSync(project, { recursive: true });
const when = new Date(Date.now() - 86_400_000).toISOString();
writeFileSync(
  join(project, "ci-session.jsonl"),
  `${JSON.stringify({
    type: "assistant",
    timestamp: when,
    sessionId: "ci-all-users",
    requestId: "req_ci_all_users",
    version: "2.1.0",
    cwd: "C:\\ci\\project",
    message: {
      id: "msg_ci_all_users",
      model: "claude-sonnet-5-5",
      usage: {
        input_tokens: 1234,
        output_tokens: 5678,
        cache_creation_input_tokens: 9000,
        cache_read_input_tokens: 120000,
      },
    },
  })}\n`,
);
const wantTokens = 1234 + 5678 + 9000 + 120000;

const demo = await startDemo({ port: 0, quiet: true });
const url = new URL(demo.url).origin;
const key = `ccu_e_ci${randomUUID().replaceAll("-", "")}`;
const keyId = randomUUID();
await demo.db
  .prepare("INSERT INTO enrollment_keys (id, name, key_hash, created_at) VALUES (?1, 'CI', ?2, ?3)")
  .bind(keyId, createHash("sha256").update(key).digest("hex"), Date.now())
  .run();
const user = userInfo().username;
const machine = `${hostname()} (${user})`;
let ok = false;
try {
  // The key comes from the environment, so it's not on the command line.
  let out = run(["setup", "--url", url, "--all-users"], { CCUNIFIED_ENROLL_KEY: key });
  if (!out.includes("Task Scheduler")) fail("the scheduled task wasn't set up");
  if (!out.includes(`${user}: Waiting for approval on ${url} as "${machine}".`)) {
    fail(`${user} didn't ask to join as "${machine}"`);
  }
  const programData = join(process.env.ProgramData ?? "C:\\ProgramData", "ccunified");
  const acl = execFileSync("icacls", [programData], { encoding: "utf8" });
  console.log(acl);
  if (/BUILTIN\\Users|Everyone|Authenticated Users/i.test(acl)) {
    fail(`${programData} is readable by everyone`);
  }
  const owner = ownerOf(programData);
  if (!/^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$/i.test(owner)) {
    fail(`${programData} belongs to ${owner}`);
  }

  // SYSTEM may not write to ccusage's cache: whatever gets cached there,
  // ccusage wrote as this account.
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  execFileSync("icacls", [cache, "/deny", "*S-1-5-18:(OI)(CI)(W)"], { stdio: "inherit" });

  // Approved on the dashboard; the SYSTEM task picks it up.
  await demo.db
    .prepare("UPDATE pairing_requests SET status = 'approved' WHERE enrollment_key_id = ?1")
    .bind(keyId)
    .run();
  execFileSync("schtasks", ["/Run", "/TN", "ccunified sync (all users)"], { stdio: "inherit" });
  let tokens = 0;
  for (let i = 0; i < 60 && tokens === 0; i++) {
    await sleep(3000);
    const row = await demo.db
      .prepare(
        `SELECT SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS n
           FROM usage_daily u JOIN machines m ON m.id = u.machine_id WHERE m.name = ?1`,
      )
      .bind(machine)
      .first();
    tokens = row?.n ?? 0;
  }
  const log = join(programData, "ccunified.log");
  const showLog = () => {
    if (existsSync(log))
      console.log(execFileSync("cmd", ["/c", "type", log], { encoding: "utf8" }));
  };
  if (tokens !== wantTokens) {
    showLog();
    fail(`the SYSTEM task uploaded ${tokens} tokens for "${machine}", not ${wantTokens}`);
  }
  console.log(`✓ The SYSTEM task uploaded ${tokens} tokens for "${machine}"`);

  const cached = filesIn(cache);
  if (cached.length === 0) {
    showLog();
    fail(`ccusage cached nothing in ${cache}: it didn't run as ${user} (or couldn't fetch prices)`);
  }
  for (const file of cached) {
    const who = ownerOf(file);
    console.log(`${file}: owned by ${who}`);
    if (/SYSTEM/i.test(who)) fail(`${file} was written by SYSTEM, not ${user}`);
  }
  console.log(`✓ ccusage ran as ${user}`);

  out = run(["status", "--all-users"]);
  if (!out.includes(`"${machine}", last upload`)) fail("status doesn't show the upload");
  out = run(["uninstall", "--all-users", "--yes"]);
  if (existsSync(programData)) fail(`${programData} is still there`);
  try {
    execFileSync("schtasks", ["/Query", "/TN", "ccunified sync (all users)"], { stdio: "ignore" });
    fail("the scheduled task is still there");
  } catch (e) {
    if (e.message.includes("still there")) throw e;
  }
  ok = true;
} finally {
  await demo.mf.dispose();
  rmSync(project, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}
console.log(ok ? "✓ Every account on a Windows computer" : "✗ failed");
process.exit(ok ? 0 : 1);
