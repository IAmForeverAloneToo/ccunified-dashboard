/**
 * The full rehearsal: the real ccunified program creates a dashboard on a
 * stand-in Cloudflare, a second machine joins with a code approved in Chrome,
 * both upload their usage from Claude Code, Codex and OpenCode, and the
 * dashboard must show exactly what ccusage reports for those logs, per
 * machine and per tool.
 *
 * Each tool's real logs are used when this computer has any (split between
 * the two machines); otherwise a small set is generated. Copies of the logs
 * are deleted at the end; only daily totals ever reach the dashboard.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { FakeCloudflare } from "./src/fake-cloudflare";
import { Machine } from "./src/machine";
import {
  ccusageTotals,
  fileCount,
  type LogSet,
  prepareLogs,
  TOOLS,
  type Totals,
} from "./src/usage-logs";

const repo = resolve(import.meta.dirname, "..");
const agentDir = join(repo, "agent");
const MODULE = "github.com/IAmForeverAloneToo/ccunified-dashboard/agent";
const VERSION = "0.0.0-rehearsal";

const ZONE = "rehearsal.test";
const HOST = `usage.${ZONE}`;
const DASHBOARD = `https://${HOST}`;
const TOKEN = `cf-token-${Date.now()}`;
const ADMIN = { username: "admin", password: "rehearsal-password-7" };
const TIMEZONE = "America/Toronto";
const NAMES: [string, string] = ["desk", "laptop"];

// Same formatting as the dashboard, for a browser set to en-US.
const compactFmt = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (n: number) =>
  Math.abs(n) < 1000 ? new Intl.NumberFormat("en-US").format(n) : compactFmt.format(n);
const money = (n: number) =>
  n !== 0 && Math.abs(n) < 0.01
    ? "< $0.01"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        ...(Math.abs(n) >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}),
      }).format(n);

const allTokens = (t: Totals) =>
  t.input_tokens + t.output_tokens + t.cache_creation_tokens + t.cache_read_tokens;
const add = (a: Totals, b: Totals): Totals => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_tokens: a.cache_creation_tokens + b.cache_creation_tokens,
  cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
  cost_usd: a.cost_usd + b.cost_usd,
});

test.skip(process.platform !== "linux", "the rehearsal runs on Linux");
test.describe.configure({ mode: "serial" });

let root: string;
let cf: FakeCloudflare;
let browser: Browser;
let page: Page;
let logs: LogSet;
let machines: [Machine, Machine];
let expected: [ReturnType<typeof ccusageTotals>, ReturnType<typeof ccusageTotals>];
let ccusagePath: string;

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  root = mkdtempSync(join(tmpdir(), "ccunified-rehearsal-"));

  // The program exactly as released, with this checkout's dashboard built in.
  execFileSync(process.execPath, ["scripts/build-assets.mjs"], {
    cwd: repo,
    env: { ...process.env, CCUNIFIED_VERSION: VERSION },
    stdio: "inherit",
  });
  execFileSync("go", ["run", "./tools/fetchccusage"], { cwd: agentDir, stdio: "inherit" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const exe = join(bin, "ccunified");
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-X ${MODULE}/internal/version.Version=${VERSION}`,
      "-o",
      exe,
      "./cmd/ccunified",
    ],
    { cwd: agentDir, stdio: "inherit" },
  );
  const ccusage = join(bin, "ccusage");
  ccusagePath = ccusage;
  copyFileSync(join(agentDir, "internal/ccusage/bin/linux-amd64/ccusage"), ccusage);
  chmodSync(ccusage, 0o755);

  logs = prepareLogs(join(root, "machines"), NAMES);
  expected = [
    ccusageTotals(ccusage, logs.machines[0], TIMEZONE),
    ccusageTotals(ccusage, logs.machines[1], TIMEZONE),
  ];
  console.log(`Logs: ${TOOLS.map((t) => `${t} ${logs.source[t]}`).join(", ")}`);
  logs.machines.forEach((m, i) => {
    const e = expected[i];
    if (!e) return;
    console.log(
      `  ${NAMES[i]}: ${TOOLS.map((t) => `${m.files[t].length} ${t}`).join(", ")} file(s); ` +
        `${allTokens(e.total).toLocaleString("en-US")} tokens, $${e.total.cost_usd.toFixed(2)} (per ccusage)`,
    );
  });

  cf = new FakeCloudflare({
    dir: join(root, "cloudflare"),
    token: TOKEN,
    accountName: "Rehearsal account",
    zone: ZONE,
    takenHostnames: [`www.${ZONE}`],
    dnsDelayMs: 4000, // like Cloudflare, a new subdomain's DNS record appears after a moment
  });
  await cf.start();
  const network = {
    cloudflareApi: cf.apiUrl,
    proxy: cf.proxyUrl,
    certFile: cf.certFile,
    publicDns: cf.dohUrl,
  };
  machines = [
    new Machine(NAMES[0], join(root, "machines"), exe, logs.machines[0].claudeDir, network),
    new Machine(NAMES[1], join(root, "machines"), exe, logs.machines[1].claudeDir, network),
  ];
  // Codex and OpenCode find their logs in the machine's home.
  machines.forEach((m, i) => {
    expect(m.home).toBe(logs.machines[i]?.home);
  });

  browser = await chromium.launch({ channel: "chrome", proxy: { server: cf.proxyUrl } });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, // the stand-in domain's certificate is self-signed
    locale: "en-US",
    timezoneId: TIMEZONE,
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await browser?.close();
  await cf?.stop();
  // Includes the copies of this computer's logs.
  if (root) rmSync(root, { recursive: true, force: true });
});

const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The tools ccusage found usage for in machine i's logs. */
const usedTools = (i: number) =>
  Object.entries(expected[i]?.byTool ?? {})
    .filter(([, t]) => allTokens(t) > 0)
    .map(([tool]) => tool);

const hasLogs = (i: number) => fileCount(logs.machines[i] as (typeof logs.machines)[0]) > 0;

function firstUploadLine(m: Machine): RegExp {
  return hasLogs(NAMES.indexOf(m.name))
    ? /✓ Uploaded this machine's history \(\d+ day\(s\) with usage; [^)]+\)/
    : /✓ Connected\. No usage on this machine yet/;
}

async function expectTiles(totals: Totals, reporting: string) {
  await page.goto(`${DASHBOARD}/?range=all`);
  const tile = (label: string) =>
    page
      .locator(".tile")
      .filter({ has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) });
  await expect(tile("Tokens").locator(".tile-value")).toHaveText(compact(allTokens(totals)));
  await expect(tile("Output tokens").locator(".tile-value")).toHaveText(
    compact(totals.output_tokens),
  );
  await expect(tile("Estimated cost").locator(".tile-value")).toHaveText(money(totals.cost_usd));
  await expect(tile("Machines reporting").locator(".tile-value")).toHaveText(reporting);

  // "All" covers the first day with usage until today.
  const summary = await page.evaluate(async () => {
    const res = await fetch("/api/summary?days=3660");
    return (await res.json()) as { to: string; by_day_machine: { day: string }[] };
  });
  const first = summary.by_day_machine.map((r) => r.day).sort()[0] ?? summary.to;
  const longDate = (d: string) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${d}T00:00:00Z`));
  const period =
    first === summary.to ? longDate(first) : `${longDate(first)} – ${longDate(summary.to)}`;
  await expect(page.locator("#tz-note")).toHaveText(`${period} · days in ${TIMEZONE}`);
}

/**
 * Totals straight from the dashboard's API (for all time unless a query says
 * otherwise): per machine, and per machine and tool ("desk/codex").
 */
async function dashboardTotals(
  query = "days=3660",
): Promise<{ machines: Record<string, Totals>; tools: Record<string, Totals> }> {
  return page.evaluate(async (q) => {
    const get = async (path: string) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const summary = await get(`/api/summary?${q}`);
    const { machines } = await get("/api/machines");
    const names = new Map<string, string>(
      machines.map((m: { id: string; name: string }) => [m.id, m.name]),
    );
    type Row = Totals & { machine_id: string; source?: string };
    const sum = (rows: Row[], key: (r: Row) => string) => {
      const out: Record<string, Totals> = {};
      for (const r of rows) {
        const k = key(r);
        const t = out[k] ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          cost_usd: 0,
        };
        out[k] = t;
        t.input_tokens += r.input_tokens;
        t.output_tokens += r.output_tokens;
        t.cache_creation_tokens += r.cache_creation_tokens;
        t.cache_read_tokens += r.cache_read_tokens;
        t.cost_usd += r.cost_usd;
      }
      return out;
    };
    const name = (r: Row) => names.get(r.machine_id) ?? r.machine_id;
    return {
      machines: sum(summary.by_day_machine, name),
      tools: sum(summary.by_machine_source, (r) => `${name(r)}/${r.source}`),
    };
  }, query);
}

/** Every machine's and every machine's tools' totals match ccusage's. */
function expectSameAsCcusage(
  actual: Awaited<ReturnType<typeof dashboardTotals>>,
  want: [ReturnType<typeof ccusageTotals>, ReturnType<typeof ccusageTotals>],
) {
  const wantTools: string[] = [];
  NAMES.forEach((name, i) => {
    const w = want[i];
    if (!w) return;
    if (allTokens(w.total) > 0) expectSameTotals(actual.machines[name], w.total);
    else expect(actual.machines[name]).toBeUndefined();
    for (const [tool, t] of Object.entries(w.byTool)) {
      if (allTokens(t) === 0) continue;
      wantTools.push(`${name}/${tool}`);
      expectSameTotals(actual.tools[`${name}/${tool}`], t);
    }
  });
  expect(Object.keys(actual.tools).sort()).toEqual(wantTools.sort());
}

function expectSameTotals(actual: Totals | undefined, want: Totals) {
  expect(actual, "machine missing from the dashboard").toBeDefined();
  const { cost_usd, ...tokens } = actual as Totals;
  const { cost_usd: wantCost, ...wantTokens } = want;
  expect(tokens).toEqual(wantTokens);
  expect(cost_usd).toBeCloseTo(wantCost, 6);
}

test("the setup wizard creates the dashboard on Cloudflare", async () => {
  const [m1] = machines;
  const s = m1.start("setup", "--no-schedule");
  await s.expect("What would you like to do?");
  await s.expect("Choose a number");
  s.answer("1");

  await s.expect("Paste the API token");
  s.answer("a-wrong-token");
  await s.expect("Cloudflare didn't accept that token");
  await s.expect("Paste the API token");
  s.answer(TOKEN);

  await s.expect(`The dashboard will use your domain ${ZONE}.`);
  await s.expect("Subdomain for the dashboard");
  s.answer("www");
  await s.expect(`www.${ZONE} is already in use`);
  await s.expect("Subdomain for the dashboard");
  s.answer("usage");

  await s.expect("Time zone");
  s.answer("Toronto");
  await s.expect(`Use ${TIMEZONE}?`);
  s.answer("y");

  await s.expect("Admin username");
  s.answer(ADMIN.username);
  await s.expect("Password (at least");
  s.answer(ADMIN.password);
  await s.expect("Type it again");
  s.answer(ADMIN.password);

  await s.expect("Name for this machine on the dashboard");
  s.answer(m1.name);
  await s.expect("How often should this machine upload its usage?");
  await s.expect("Choose a number [2]");
  s.answer(""); // the default: every 30 minutes

  await s.expect(`Dashboard:   ${DASHBOARD}`);
  await s.expect("Create it now?");
  s.answer("y");

  for (const done of [
    "✓ Created the database",
    "✓ Set up the database tables",
    `✓ Set the time zone to ${TIMEZONE}`,
    `✓ Created the admin account "${ADMIN.username}"`,
    "✓ Uploaded the dashboard",
    "✓ Turned off the workers.dev address",
    `✓ Connected ${DASHBOARD}`,
    "✓ Registered this machine",
    `✓ ${DASHBOARD} is online`,
    "✓ Saved this machine's settings",
    "- No background sync was set up",
  ]) {
    await s.expect(done, 120_000);
  }
  await s.expect(firstUploadLine(m1), 180_000);
  await s.expect(`Done! Open ${DASHBOARD} and log in as "${ADMIN.username}"`);
  expect(await s.exit()).toBe(0);

  // What the wizard did on "Cloudflare".
  expect([...cf.databases.values()]).toEqual(["ccunified"]);
  expect(cf.worker?.name).toBe("ccunified");
  expect(cf.workersDev).toBe(false);
  expect(cf.domains.map((d) => d.hostname)).toEqual([HOST]);
  // It waited for the DNS record instead of visiting too early.
  expect(cf.earlyVisits).toBe(0);
});

test("the admin logs in and sees the first machine's usage", async () => {
  await page.goto(DASHBOARD);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.getByLabel("Username").fill(ADMIN.username);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await expectTiles(expected[0].total, "1 of 1");
  const totals = await dashboardTotals();
  expectSameTotals(totals.machines[NAMES[0]], expected[0].total);
});

test("a second machine joins with a code approved in the dashboard", async () => {
  const [, m2] = machines;
  const s = m2.start("setup", "--no-schedule");
  await s.expect("Choose a number");
  s.answer("2");
  await s.expect("Dashboard address");
  s.answer(HOST); // without https://, as people type it
  await s.expect("Name for this machine on the dashboard");
  s.answer(m2.name);
  await s.expect("Choose a number [2]");
  s.answer("1"); // every 15 minutes
  const [, code] = await s.expect(/Your code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/);
  const [, link] = await s.expect(/1\. Open (\S+)/);
  expect(link).toBe(`${DASHBOARD}/approve`);

  await page.goto(link as string);
  await expect(page.getByRole("heading", { name: "Approve a machine" })).toBeVisible();
  await expect(page.getByText(m2.name).first()).toBeVisible(); // listed as waiting
  // Typed the lazy way: lower case, no dash.
  await page
    .getByLabel("Code shown on the machine")
    .fill((code as string).replace("-", "").toLowerCase());
  await expect(page.getByLabel("Code shown on the machine")).toHaveValue(code as string);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(`Approved ${m2.name}.`)).toBeVisible();

  await s.expect(`Approved! This machine is "${m2.name}" on the dashboard.`, 60_000);
  await s.expect("✓ Saved this machine's settings");
  await s.expect(firstUploadLine(m2), 180_000);
  expect(await s.exit()).toBe(0);
});

test("the dashboard shows exactly what ccusage reports for each machine and tool", async () => {
  const totals = await dashboardTotals();
  expect(Object.keys(totals.machines).sort()).toEqual(NAMES.filter((_, i) => hasLogs(i)).sort());
  expectSameAsCcusage(totals, expected);
  await expectTiles(add(expected[0].total, expected[1].total), "2 of 2");
  await page.screenshot({ path: test.info().outputPath("overview.png"), fullPage: true });

  await page.goto(`${DASHBOARD}/machines`);
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
  for (const name of NAMES) {
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText(VERSION);
    await expect(row).toContainText(
      hasLogs(NAMES.indexOf(name)) ? "Reporting" : "Waiting for first upload",
    );
    for (const tool of usedTools(NAMES.indexOf(name))) {
      await expect(row).toContainText(TOOL_NAMES[tool] ?? tool);
    }
  }
  await page.screenshot({ path: test.info().outputPath("machines.png"), fullPage: true });

  await page.goto(`${DASHBOARD}/?range=all&by=tool`);
  await expect(page.getByRole("heading", { name: /tokens by tool/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("tools.png"), fullPage: true });
});

test("syncing again uploads nothing new and changes no numbers", async () => {
  const [m1] = machines;
  const sync = await m1.run("sync");
  expect(sync.code, sync.output).toBe(0);
  const status = await m1.run("status");
  expect(status.code, status.output).toBe(0);
  expect(status.output).toMatch(new RegExp(`Dashboard:\\s+${DASHBOARD}\\n`));
  expect(status.output).toMatch(new RegExp(`Machine:\\s+${m1.name}\\n`));
  expect(status.output).toMatch(new RegExp(`Time zone:\\s+${TIMEZONE}\\n`));
  const toolsLine = status.output.match(/Tools:\s+(.*)\n/)?.[1] ?? "";
  for (const tool of usedTools(0)) expect(toolsLine).toContain(TOOL_NAMES[tool] ?? tool);
  if (hasLogs(0))
    expect(status.output).toMatch(
      /Last upload:\s+just now \(\d+ day\(s\) with usage, 0 row\(s\) changed\)/,
    );
  expect(status.output).not.toContain("Last problem");

  const totals = await dashboardTotals();
  expectSameAsCcusage(totals, expected);
  await expectTiles(add(expected[0].total, expected[1].total), "2 of 2");
});

test("a custom date range shows exactly what ccusage reports for those days", async () => {
  const shift = (date: string, n: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`${DASHBOARD}/`);
  const today = await page.evaluate(
    async () => (await (await fetch("/api/summary?days=1")).json()).today as string,
  );
  const from = shift(today, -2);
  const to = today;
  await page.locator(".range-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose dates" });
  await dialog.getByLabel("From", { exact: true }).fill(from);
  await dialog.getByLabel("To", { exact: true }).fill(to);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${to}`));

  const want = logs.machines.map((m) =>
    ccusageTotals(ccusagePath, m, TIMEZONE, { since: from, until: to }),
  ) as typeof expected;
  expectSameAsCcusage(await dashboardTotals(`from=${from}&to=${to}`), want);
  const sum = add(want[0].total, want[1].total);
  const tile = (label: string) =>
    page
      .locator(".tile")
      .filter({ has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) })
      .locator(".tile-value");
  await expect(tile("Tokens")).toHaveText(compact(allTokens(sum)));
  await expect(tile("Output tokens")).toHaveText(compact(sum.output_tokens));
  await expect(tile("Estimated cost")).toHaveText(money(sum.cost_usd));
  await page.screenshot({ path: test.info().outputPath("custom-range.png"), fullPage: true });
});
