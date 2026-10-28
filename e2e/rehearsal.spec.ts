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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { modelFamily } from "../dashboard/src/lib/models";
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
let priceLists: Server | undefined;
let exePath: string;
let network: ConstructorParameters<typeof Machine>[4];
/**
 * The price lists the machines download: Claude models on models.dev (as
 * Anthropic's entries) and GPT models on LiteLLM, each at its own made-up
 * price; other models aren't listed. Filled in once the logs are known.
 */
const PRICES = {
  modelsDev: { anthropic: { models: {} as Record<string, unknown> } },
  liteLLM: {} as Record<string, unknown>,
};
/** Each listed model's price: input, output, cache write, cache read per million tokens. */
const listed = new Map<string, number[]>();

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
  exePath = exe;
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
  const models = new Set(
    expected.flatMap((e) => Object.values(e.byToolModel).flatMap(Object.keys)),
  );
  [...models].forEach((model, i) => {
    const name = model.slice(model.lastIndexOf("/") + 1);
    const price = [1 + i, 5 + i, 1.25 + i, 0.1 * (i + 1)] as [number, number, number, number];
    if (name.startsWith("claude-")) {
      const [input, output, cache_write, cache_read] = price;
      PRICES.modelsDev.anthropic.models[name] = {
        cost: { input, output, cache_write, cache_read },
      };
    } else if (name.startsWith("gpt-")) {
      const [input, output, write, read] = price.map((p) => p / 1e6);
      PRICES.liteLLM[name] = {
        input_cost_per_token: input,
        output_cost_per_token: output,
        cache_creation_input_token_cost: write,
        cache_read_input_token_cost: read,
      };
    } else {
      return;
    }
    listed.set(model, price);
  });
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
  // Price lists for the dashboard's own costs, served here.
  const lists = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/models.dev.json" ? PRICES.modelsDev : PRICES.liteLLM));
  });
  priceLists = lists;
  const pricesPort = await new Promise<number>((resolve) =>
    lists.listen(0, "127.0.0.1", () => resolve((lists.address() as AddressInfo).port)),
  );
  network = {
    cloudflareApi: cf.apiUrl,
    proxy: cf.proxyUrl,
    certFile: cf.certFile,
    publicDns: cf.dohUrl,
    modelsDevUrl: `http://127.0.0.1:${pricesPort}/models.dev.json`,
    liteLLMUrl: `http://127.0.0.1:${pricesPort}/litellm.json`,
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
  priceLists?.close();
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
  await page.locator("form").getByRole("button", { name: "Approve" }).click();
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

  // A year: the dashboard gets the rows summed per week, and the totals still
  // match ccusage's for those 365 days.
  const yearAgo = shift(today, -364);
  const year = logs.machines.map((m) =>
    ccusageTotals(ccusagePath, m, TIMEZONE, { since: yearAgo, until: today }),
  ) as typeof expected;
  const yearSum = add(year[0].total, year[1].total);
  await page.goto(`${DASHBOARD}/?range=365`);
  await expect(page.locator("#chart-title")).toHaveText("Weekly tokens by machine");
  await expect(tile("Tokens")).toHaveText(compact(allTokens(yearSum)));
  await expect(tile("Output tokens")).toHaveText(compact(yearSum.output_tokens));
  await expect(tile("Estimated cost")).toHaveText(money(yearSum.cost_usd));
});

test("filters show exactly what ccusage reports for those machines, tools and models", async () => {
  const filterButton = (name: string) =>
    page.getByRole("button", { name: new RegExp(`^${name} `) });
  /** Starts from no filters, then ticks the given items of each filter. */
  async function filterTo(picks: Record<string, string[]>) {
    await page.goto(`${DASHBOARD}/?range=all`);
    await expect(page.locator(".tile-value").first()).not.toBeEmpty();
    for (const [name, labels] of Object.entries(picks)) {
      await filterButton(name).click();
      const list = page.getByRole("dialog", { name: `Filter by ${name.toLowerCase()}` });
      for (const label of labels) {
        await list.getByRole("checkbox", { name: label, exact: true }).check();
      }
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
    }
  }
  /** A table's exact total tokens and cost: its Total row, or its only row. */
  async function tableTotal(title: string): Promise<{ tokens: number; cost: string }> {
    const card = page
      .locator(".card")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    const headers = await card.locator("thead th").allTextContents();
    const row =
      (await card.locator("tfoot tr").count()) > 0
        ? card.locator("tfoot tr")
        : card.locator("tbody tr");
    await expect(row).toHaveCount(1);
    const cells = row.locator("th, td");
    const tokens = Number(
      (await cells.nth(headers.indexOf("Total tokens")).textContent())?.replaceAll(",", ""),
    );
    const cost = (await cells.nth(headers.indexOf("Est. cost")).textContent()) ?? "";
    return { tokens, cost };
  }
  const none: Totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
  };
  const sum = (list: Totals[]) => list.reduce(add, none);
  const tile = (label: string) =>
    page
      .locator(".tile")
      .filter({ has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) })
      .locator(".tile-value");
  const expectTable = async (title: string, want: Totals, what: string) => {
    const got = await tableTotal(title);
    expect(got.tokens, what).toBe(allTokens(want));
    expect(got.cost, what).toBe(money(want.cost_usd));
  };

  // One tool at a time, across both machines.
  const tools = [...new Set(NAMES.flatMap((_, i) => usedTools(i)))];
  expect(tools.length).toBeGreaterThan(1);
  for (const tool of tools) {
    await filterTo({ Tools: [TOOL_NAMES[tool] ?? tool] });
    await expect(page).toHaveURL(new RegExp(`tool=${tool}`));
    const want = sum(expected.map((e) => e.byTool[tool] ?? none));
    await expectTable("Machines", want, tool);
    await expect(tile("Tokens")).toHaveText(compact(allTokens(want)));
  }

  // A machine and a tool together.
  const i = NAMES.findIndex((_, n) => usedTools(n).includes("claude") && usedTools(n).length > 1);
  if (i >= 0) {
    await filterTo({ Machines: [NAMES[i] as string], Tools: ["Claude Code"] });
    await expectTable("Machines", expected[i]?.byTool.claude as Totals, `${NAMES[i]} + claude`);
  }

  // Each model family, as the chart names them, whichever tool used it.
  const families = new Map<string, { label: string; totals: Totals[] }>();
  for (const e of expected) {
    for (const models of Object.values(e.byToolModel)) {
      for (const [model, t] of Object.entries(models)) {
        if (allTokens(t) === 0) continue; // ccunified leaves out models with no tokens
        const f = modelFamily(model);
        const entry = families.get(f.id) ?? { label: f.label, totals: [] };
        entry.totals.push(t);
        families.set(f.id, entry);
      }
    }
  }
  console.log(`  model families: ${[...families.values()].map((f) => f.label).join(", ")}`);
  for (const { label, totals } of families.values()) {
    await filterTo({ Models: [label] });
    await expectTable("Models", sum(totals), label);
  }

  // With one machine picked, the other lists offer only what ccusage found
  // on that machine.
  const listed = async (name: string) => {
    await filterButton(name).click();
    const list = page.getByRole("dialog", { name: `Filter by ${name.toLowerCase()}` });
    const items = await list
      .locator(".ms-list > ul > li")
      .evaluateAll((lis) =>
        lis.map((li) => li.querySelector("label span")?.textContent?.trim() ?? ""),
      );
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    return items.sort();
  };
  if (NAMES.filter((_, n) => hasLogs(n)).length > 1) {
    for (const [n, name] of NAMES.entries()) {
      if (!hasLogs(n)) continue;
      await filterTo({ Machines: [name] });
      const tools = usedTools(n).map((t) => TOOL_NAMES[t] ?? t);
      expect(await listed("Tools"), `${name}: tools`).toEqual(tools.sort());
      if (families.size < 2) continue;
      const own = new Set<string>();
      for (const models of Object.values(expected[n]?.byToolModel ?? {})) {
        for (const [model, t] of Object.entries(models)) {
          if (allTokens(t) > 0) own.add(modelFamily(model).label);
        }
      }
      expect(await listed("Models"), `${name}: model families`).toEqual([...own].sort());
    }
  }

  // The chart names every family; "Other models" is only for more than eight.
  await page.goto(`${DASHBOARD}/?range=all&by=model`);
  const legend = page.locator(".legend-item");
  if (families.size > 1) {
    await expect(legend).toHaveCount(Math.min(families.size, 8));
    if (families.size <= 8) await expect(legend.filter({ hasText: "Other models" })).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath("models.png"), fullPage: true });

  // Clearing the filters brings back everything.
  await filterTo({ Tools: [TOOL_NAMES[tools[0] as string] ?? ""] });
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(tile("Tokens")).toHaveText(
    compact(allTokens(add(expected[0].total, expected[1].total))),
  );
});

test("with the price lists, costs are each model's tokens at its listed price", async () => {
  // The machines sent the prices of the dashboard's models when they synced.
  const prices = (await page.evaluate(
    async () => (await (await fetch("/api/prices")).json()).models,
  )) as {
    model: string;
    models_dev: { input: number } | null;
    litellm: { input: number } | null;
  }[];
  expect(listed.size).toBeGreaterThan(0);
  for (const [model, p] of listed) {
    const row = prices.find((r) => r.model === model);
    expect((row?.models_dev ?? row?.litellm)?.input, model).toBeCloseTo(p[0] as number);
  }
  const setMode = (mode: string) =>
    page.evaluate(
      async (m) =>
        (
          await fetch("/api/prices", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: m }),
          })
        ).status,
      mode,
    );
  expect(await setMode("lists")).toBe(200);
  let want = 0;
  for (const e of expected) {
    for (const models of Object.values(e.byToolModel)) {
      for (const [model, t] of Object.entries(models)) {
        const p = listed.get(model);
        want += p
          ? (t.input_tokens * (p[0] as number) +
              t.output_tokens * (p[1] as number) +
              t.cache_creation_tokens * (p[2] as number) +
              t.cache_read_tokens * (p[3] as number)) /
            1e6
          : t.cost_usd;
      }
    }
  }
  await page.goto(`${DASHBOARD}/?range=all`);
  const cost = page
    .locator(".tile")
    .filter({ has: page.locator(".tile-label", { hasText: /^Estimated cost$/ }) })
    .locator(".tile-value");
  await expect(cost).toHaveText(money(want));
  expect(await setMode("ccusage")).toBe(200);
  await page.reload();
  await expect(cost).toHaveText(money(add(expected[0].total, expected[1].total).cost_usd));
});

// ---------- Adding many machines with an enrollment key ----------

/** Creates an enrollment key as the logged-in admin. */
async function newEnrollKey(name: string): Promise<string> {
  const res = await page.evaluate(async (n) => {
    const r = await fetch("/api/enrollment-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: n,
        department_id: null,
        owner_id: null,
        expires_in_days: 1,
        max_uses: null,
      }),
    });
    return { status: r.status, body: await r.json() };
  }, name);
  expect(res.status).toBe(201);
  return res.body.key as string;
}

/** Approves the named machines on the Approvals page, all at once. */
async function approveEnrolled(names: string[]) {
  await page.goto(`${DASHBOARD}/approve`);
  const list = page
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "Joined with an enrollment key" }) });
  for (const name of names) await list.getByRole("checkbox", { name: `Select ${name}` }).check();
  await list.getByRole("button", { name: `Approve ${names.length}` }).click();
  await expect(page.getByText(`Approved ${names.length} machine`)).toBeVisible();
}

test("a script adds a machine with an enrollment key; it uploads once approved", async () => {
  const more = prepareLogs(join(root, "enrolled"), ["kiosk", "unused"]);
  const kiosk = new Machine(
    "kiosk",
    join(root, "enrolled"),
    exePath,
    more.machines[0].claudeDir,
    network,
  );
  const want = ccusageTotals(ccusagePath, more.machines[0], TIMEZONE);
  const key = await newEnrollKey("Kiosks");
  const setup = () =>
    kiosk.run(
      "setup",
      "--url",
      HOST,
      "--enroll-key",
      key,
      "--name",
      "kiosk",
      "--this-user", // the rehearsal may run as root
      "--no-schedule",
    );

  let r = await setup();
  expect(r.output).toContain(`Asked ${DASHBOARD} to add this machine as "kiosk".`);
  expect(r.code).toBe(0);
  r = await kiosk.run("status");
  expect(r.output).toMatch(/Status:\s+waiting for approval/);
  r = await kiosk.run("sync");
  expect(r.output).toContain(`Waiting for approval on ${DASHBOARD} as "kiosk".`);
  expect(r.code).toBe(0);
  // Running the script again changes nothing.
  r = await setup();
  expect(r.output).toContain("is waiting for approval");

  await approveEnrolled(["kiosk"]);
  r = await kiosk.run("sync");
  expect(r.code).toBe(0);
  expect(r.output).toMatch(/Uploaded the full history/);
  const totals = await dashboardTotals();
  if (allTokens(want.total) > 0) expectSameTotals(totals.machines.kiosk, want.total);
  r = await setup();
  expect(r.output).toContain(`This machine already uploads to ${DASHBOARD} as "kiosk".`);
  expect(r.code).toBe(0);
});

test("a script run as root sets up every account on a computer, each as its own machine", async () => {
  test.skip(process.getuid?.() !== 0, "needs root, to add accounts and run as them");
  const tag = `ccu${Date.now() % 100_000}`;
  const [alice, bob, carol, dave] = ["a", "b", "c", "d"].map((x) => `${tag}${x}`) as [
    string,
    string,
    string,
    string,
  ];
  const accounts = join(root, "accounts");
  // Every account must reach the program and its own home.
  chmodSync(root, 0o755);
  const logsOf = prepareLogs(accounts, [alice, bob]);
  chmodSync(accounts, 0o755);
  const homeOf = (name: string) => join(accounts, name, "home");
  for (const name of [carol, dave]) mkdirSync(homeOf(name), { recursive: true });
  // Claude Code's logs where it keeps them by default.
  logsOf.machines.forEach((m) => {
    renameSync(m.claudeDir, join(m.home, ".claude"));
    m.claudeDir = join(m.home, ".claude");
  });
  // dave set ccunified up himself: left alone.
  mkdirSync(join(homeOf(dave), ".config", "ccunified"), { recursive: true });
  writeFileSync(join(homeOf(dave), ".config", "ccunified", "config.json"), "{}");
  const created: string[] = [];
  try {
    for (const name of [alice, bob, carol, dave]) {
      execFileSync("useradd", ["-M", "-d", homeOf(name), "-s", "/bin/sh", name]);
      created.push(name);
      chmodSync(join(accounts, name), 0o755);
      execFileSync("chown", ["-R", `${name}:${name}`, homeOf(name)]);
    }
    const want = logsOf.machines.map((m) => ccusageTotals(ccusagePath, m, TIMEZONE));
    const machineName = (user: string) => `${hostname()} (${user})`;

    const computer = new Machine(
      "computer",
      join(root, "computer"),
      exePath,
      "/nonexistent",
      network,
      {
        CCUNIFIED_SYSTEM_HOME: join(root, "computer", "system"),
        CCUNIFIED_SYSTEM_PROGRAM_DIR: join(root, "computer", "program"),
      },
    );
    chmodSync(join(root, "computer"), 0o755);
    const key = await newEnrollKey("Every account");
    let r = await computer.run(
      "setup",
      "--url",
      HOST,
      "--enroll-key",
      key,
      "--all-users",
      "--no-schedule",
    );
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("✓ Installed the program in");
    for (const user of [alice, bob]) {
      expect(r.output).toContain(
        `${user}: Waiting for approval on ${DASHBOARD} as "${machineName(user)}".`,
      );
    }
    expect(r.output).toContain(`${carol}: No usage on this account yet`);
    expect(r.output).toContain(`${dave}: set up by the account itself; skipped`);

    await approveEnrolled([machineName(alice), machineName(bob)]);
    r = await computer.run("sync", "--all-users");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(new RegExp(`${alice}: Uploaded the full history`));

    const totals = await dashboardTotals();
    [alice, bob].forEach((user, i) => {
      const w = want[i];
      if (w && allTokens(w.total) > 0)
        expectSameTotals(totals.machines[machineName(user)], w.total);
    });
    expect(Object.keys(totals.machines).some((n) => n.includes(carol))).toBe(false);
    // ccusage ran as each account: nothing in their homes belongs to root.
    for (const user of [alice, bob]) {
      expect(
        execFileSync("find", [homeOf(user), "-user", "root"])
          .toString()
          .trim(),
      ).toBe("");
    }

    r = await computer.run("status", "--all-users");
    expect(r.output).toMatch(
      new RegExp(
        `${alice}:\\s+"${machineName(alice).replace(/[()]/g, "\\$&")}", last upload just now`,
      ),
    );
    r = await computer.run("uninstall", "--all-users", "--yes");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(machineName(alice));
    expect(existsSync(join(root, "computer", "system"))).toBe(false);
    expect(existsSync(join(root, "computer", "program"))).toBe(false);
  } finally {
    for (const name of created) execFileSync("userdel", [name]);
  }
});
