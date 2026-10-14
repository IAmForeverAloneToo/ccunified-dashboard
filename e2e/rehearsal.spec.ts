/**
 * The full rehearsal: the real ccunified program creates a dashboard on a
 * stand-in Cloudflare, a second machine joins with a code approved in Chrome,
 * both upload their Claude Code usage, and the dashboard must show exactly
 * what ccusage reports for those logs.
 *
 * Real logs are used when this computer has any (split between the two
 * machines); otherwise a small set is generated. Copies of the logs are
 * deleted at the end; only daily totals ever reach the dashboard.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { ccusageTotals, type LogSet, prepareLogs, type Totals } from "./src/claude-logs";
import { FakeCloudflare } from "./src/fake-cloudflare";
import { Machine } from "./src/machine";

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
let expected: [Totals, Totals];

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
  copyFileSync(join(agentDir, "internal/ccusage/bin/linux-amd64/ccusage"), ccusage);
  chmodSync(ccusage, 0o755);

  logs = prepareLogs(join(root, "machines"), NAMES);
  expected = [
    ccusageTotals(ccusage, logs.machines[0].claudeDir, TIMEZONE),
    ccusageTotals(ccusage, logs.machines[1].claudeDir, TIMEZONE),
  ];
  console.log(`Claude Code logs: ${logs.source}`);
  logs.machines.forEach((m, i) => {
    console.log(
      `  ${NAMES[i]}: ${m.files.length} file(s), ${allTokens(expected[i] as Totals).toLocaleString("en-US")} tokens, ` +
        `$${(expected[i] as Totals).cost_usd.toFixed(2)} (per ccusage)`,
    );
  });

  cf = new FakeCloudflare({
    dir: join(root, "cloudflare"),
    token: TOKEN,
    accountName: "Rehearsal account",
    zone: ZONE,
    takenHostnames: [`www.${ZONE}`],
  });
  await cf.start();
  const network = { cloudflareApi: cf.apiUrl, proxy: cf.proxyUrl, certFile: cf.certFile };
  machines = [
    new Machine(NAMES[0], join(root, "machines"), exe, logs.machines[0].claudeDir, network),
    new Machine(NAMES[1], join(root, "machines"), exe, logs.machines[1].claudeDir, network),
  ];

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
  // Includes the copies of this computer's Claude Code logs.
  if (root) rmSync(root, { recursive: true, force: true });
});

function firstUploadLine(m: Machine): RegExp {
  const files = logs.machines[NAMES.indexOf(m.name)]?.files.length ?? 0;
  return files > 0
    ? /✓ Uploaded this machine's history \(\d+ day\(s\) with usage\)/
    : /✓ Connected\. No Claude Code logs on this machine yet/;
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

/** Each machine's totals for all time, straight from the dashboard's API. */
async function dashboardTotals(): Promise<Record<string, Totals>> {
  return page.evaluate(async () => {
    const get = async (path: string) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const summary = await get("/api/summary?days=3660");
    const { machines } = await get("/api/machines");
    const names = new Map<string, string>(
      machines.map((m: { id: string; name: string }) => [m.id, m.name]),
    );
    const out: Record<string, Totals> = {};
    for (const r of summary.by_day_machine) {
      const name = names.get(r.machine_id) ?? r.machine_id;
      const t = out[name] ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0,
      };
      out[name] = t;
      t.input_tokens += r.input_tokens;
      t.output_tokens += r.output_tokens;
      t.cache_creation_tokens += r.cache_creation_tokens;
      t.cache_read_tokens += r.cache_read_tokens;
      t.cost_usd += r.cost_usd;
    }
    return out;
  });
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

  await expectTiles(expected[0], "1 of 1");
  const totals = await dashboardTotals();
  expectSameTotals(totals[NAMES[0]], expected[0]);
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

test("the dashboard shows exactly what ccusage reports for each machine", async () => {
  const totals = await dashboardTotals();
  expect(Object.keys(totals).sort()).toEqual(
    NAMES.filter((_, i) => (logs.machines[i]?.files.length ?? 0) > 0).sort(),
  );
  NAMES.forEach((name, i) => {
    if ((logs.machines[i]?.files.length ?? 0) > 0)
      expectSameTotals(totals[name], expected[i] as Totals);
  });
  await expectTiles(add(expected[0], expected[1]), "2 of 2");
  await page.screenshot({ path: test.info().outputPath("overview.png"), fullPage: true });

  await page.goto(`${DASHBOARD}/machines`);
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
  for (const name of NAMES) {
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText(VERSION);
    await expect(row).toContainText(
      (logs.machines[NAMES.indexOf(name)]?.files.length ?? 0) > 0
        ? "Reporting"
        : "Waiting for first upload",
    );
  }
  await page.screenshot({ path: test.info().outputPath("machines.png"), fullPage: true });
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
  if (logs.machines[0].files.length > 0)
    expect(status.output).toMatch(
      /Last upload:\s+just now \(\d+ day\(s\) with usage, 0 row\(s\) changed\)/,
    );
  expect(status.output).not.toContain("Last problem");

  const totals = await dashboardTotals();
  if (logs.machines[0].files.length > 0) expectSameTotals(totals[NAMES[0]], expected[0]);
  await expectTiles(add(expected[0], expected[1]), "2 of 2");
});
