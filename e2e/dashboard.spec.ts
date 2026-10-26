/**
 * The dashboard's date range picker, in Chrome and Firefox, against the demo
 * data: 90 days of usage for four machines, with some days missing.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { day as formatDay } from "../dashboard/src/lib/format";
import { modelFamily } from "../dashboard/src/lib/models";
import { toolName } from "../dashboard/src/lib/tools";
import { startDemo } from "../worker/scripts/demo.mjs";

let demo: Awaited<ReturnType<typeof startDemo>>;

test.beforeAll(async () => {
  demo = await startDemo({ port: 0, quiet: true });
});
test.afterAll(async () => {
  await demo?.mf.dispose();
});
test.use({
  locale: "en-US",
  timezoneId: "America/Toronto",
  viewport: { width: 1280, height: 900 },
});

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const addMonths = (date: string, n: number) => {
  const d = new Date(`${monthStart(date)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const compactFmt = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (n: number) =>
  Math.abs(n) < 1000 ? new Intl.NumberFormat("en-US").format(n) : compactFmt.format(n);

/** Logs in as a demo user (see worker/scripts/demo.mjs); "demo" is the admin. */
async function logIn(page: Page, username = "demo") {
  await page.goto(new URL("/login", demo.url).href);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(`${username}-password`);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

/** Today in the dashboard's time zone. */
const dashboardToday = (page: Page) =>
  page.evaluate(async () => (await (await fetch("/api/summary?days=1")).json()).today as string);

/** All tokens between from and to, straight from the API. */
const apiTokens = (page: Page, from: string, to: string) =>
  page.evaluate(
    async ([a, b]) => {
      const s = await (await fetch(`/api/summary?from=${a}&to=${b}`)).json();
      let total = 0;
      for (const r of s.by_day_machine) {
        total += r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
      }
      return total;
    },
    [from, to],
  );

const tile = (page: Page, label: string) =>
  page
    .locator(".tile")
    .filter({ has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator(".tile-value");

async function openPicker(page: Page): Promise<Locator> {
  await page.locator(".range-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose dates" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Picks an option of a filter by clicking its label, as a person would. */
async function choose(page: Page, name: string, value: string) {
  const option = page
    .locator("label")
    .filter({ has: page.locator(`input[name="${name}"][value="${value}"]`) });
  await expect(option).toBeVisible();
  await option.click();
}

const day = (page: Page, date: string) => page.locator(`.drp-day[data-date="${date}"]`);
const status = (dialog: Locator) => dialog.locator(".drp-status");
const field = (dialog: Locator, name: "From" | "To") => dialog.getByLabel(name, { exact: true });

test("pick a range with the mouse; nothing changes until Apply", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const from = addDays(today, -20);
  const to = addDays(today, -10);
  const dialog = await openPicker(page);

  await day(page, from).click();
  await expect(status(dialog)).toContainText("choose the end date");
  await day(page, to).hover();
  await expect(page.locator("td.in-range.is-preview").first()).toBeVisible();
  await day(page, to).click();
  await expect(field(dialog, "From")).toHaveValue(from);
  await expect(field(dialog, "To")).toHaveValue(to);
  await expect(status(dialog)).toContainText("11 days");
  expect(page.url()).not.toContain("range=custom");

  await test.info().attach("picker", { body: await page.screenshot(), contentType: "image/png" });
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${to}`));
  await expect(page.locator(".range-button")).toHaveClass(/active/);
  await expect(page.locator('input[name="range"]:checked')).toHaveCount(0);
  await expect(tile(page, "Tokens")).toHaveText(compact(await apiTokens(page, from, to)));
});

test("Escape, Cancel and clicking outside discard the choice", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const pick = addDays(today, -5);

  let dialog = await openPicker(page);
  await day(page, pick).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  dialog = await openPicker(page);
  // It opens on the period being shown (the last 30 days), not the discarded pick.
  await expect(field(dialog, "From")).toHaveValue(addDays(today, -29));
  await expect(field(dialog, "To")).toHaveValue(today);
  await day(page, pick).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  dialog = await openPicker(page);
  await day(page, pick).click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();

  expect(page.url()).not.toContain("range=custom");
  await expect(page.locator(".range-button")).toHaveText("Custom");
  await expect(page.locator('input[name="range"][value="30"]')).toBeChecked();
});

test("works with the keyboard alone", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  await page.locator(".range-button").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose dates" });
  await expect(dialog).toBeVisible();
  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("data-date", today);
  await expect(focused).toHaveAttribute("aria-label", new RegExp(`, ${today.slice(0, 4)}`));

  // Days after today can't be reached.
  await page.keyboard.press("ArrowRight");
  await expect(focused).toHaveAttribute("data-date", today);

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(status(dialog)).toContainText("choose the end date");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  const from = addDays(today, -6);
  const to = addDays(today, -1);
  await expect(field(dialog, "From")).toHaveValue(from);
  await expect(field(dialog, "To")).toHaveValue(to);

  // Page Up goes back a month, showing it if needed.
  await page.keyboard.press("PageUp");
  await expect(focused).toHaveAttribute(
    "data-date",
    new RegExp(`^${addMonths(from, -1).slice(0, 7)}`),
  );
  await page.keyboard.press("PageDown");
  await expect(focused).toHaveAttribute("data-date", from);

  // Tab on to Apply.
  for (let i = 0; i < 6; i++) {
    if ((await focused.textContent()) === "Apply") break;
    await page.keyboard.press("Tab");
  }
  await expect(focused).toHaveText("Apply");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${to}`));
  await expect(page.locator(".range-button")).toBeFocused();
});

test("typed dates, and Enter to apply", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const from = addDays(today, -40);
  const to = addDays(today, -33);
  const dialog = await openPicker(page);

  await field(dialog, "From").fill("2026-02-30");
  await field(dialog, "To").focus();
  await expect(field(dialog, "From")).toHaveAttribute("aria-invalid", "true");
  await expect(status(dialog)).toContainText("Enter dates like");

  // Slashes and missing zeros are fine.
  await field(dialog, "From").fill(from.replaceAll("-", "/").replace(/\/0/g, "/"));
  await field(dialog, "To").fill(to);
  await field(dialog, "To").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${to}`));
  await expect(tile(page, "Tokens")).toHaveText(compact(await apiTokens(page, from, to)));
});

test("shortcuts pick calendar ranges", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const dialog = await openPicker(page);
  await dialog.getByRole("button", { name: "Last month" }).click();
  const from = addMonths(today, -1);
  const to = addDays(monthStart(today), -1);
  await expect(field(dialog, "From")).toHaveValue(from);
  await expect(field(dialog, "To")).toHaveValue(to);
  await expect(dialog.getByRole("button", { name: "Last month" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${to}`));
});

test("future days are unavailable and dots mark the days with usage", async ({ page }) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const dialog = await openPicker(page);
  await expect(dialog.getByRole("button", { name: "Next month" })).toBeDisabled();
  const tomorrow = day(page, addDays(today, 1));
  if ((await tomorrow.count()) > 0) {
    await expect(tomorrow).toHaveAttribute("aria-disabled", "true");
    await tomorrow.click({ force: true });
    await expect(status(dialog)).not.toContainText("choose the end date");
  }

  const shown = await page
    .locator(".drp-day")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.date ?? ""));
  const first = shown[0] ?? "";
  const last = shown.at(-1) ?? "";
  const withUsage = await page.evaluate(
    async ([a, b]) =>
      (await (await fetch(`/api/usage-days?from=${a}&to=${b}`)).json()).days as string[],
    [first, last],
  );
  expect(withUsage.length).toBeGreaterThan(0);
  expect(withUsage.length).toBeLessThan(shown.filter((d) => d <= today).length); // the demo has gaps
  await expect
    .poll(() =>
      page
        .locator(".drp-day.has-usage")
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.date)),
    )
    .toEqual(withUsage);
});

test("a custom range survives a reload, and Back returns to the previous period", async ({
  page,
}) => {
  await logIn(page);
  const today = await dashboardToday(page);
  const from = addDays(today, -15);
  const to = addDays(today, -8);
  const dialog = await openPicker(page);
  await field(dialog, "From").fill(from);
  await field(dialog, "To").fill(to);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`from=${from}&to=${to}`));
  const label = await page.locator(".range-button").innerText();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".range-button")).toHaveText(label);
  const reopened = await openPicker(page);
  await expect(field(reopened, "From")).toHaveValue(from);
  await page.keyboard.press("Escape");

  await page.goBack();
  await expect(page).not.toHaveURL(/range=custom/);
  await expect(page.locator('input[name="range"][value="30"]')).toBeChecked();
  await expect(page.locator(".range-button")).toHaveText("Custom");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the picker is a full-width panel with one month", async ({ page }) => {
    await logIn(page);
    const dialog = await openPicker(page);
    const box = await dialog.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(390);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
    await expect(dialog.locator(".drp-grid")).toHaveCount(1);
    await test.info().attach("phone", { body: await page.screenshot(), contentType: "image/png" });
    await dialog.getByRole("button", { name: "This month" }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/range=custom/);
  });

  test("filter lists fit on the screen", async ({ page }) => {
    await logIn(page);
    await page.getByRole("button", { name: /^Models / }).click();
    const list = page.getByRole("dialog", { name: "Filter by models" });
    await expect(list).toBeVisible();
    const box = await list.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(8);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390 - 8);
  });
});

test.describe("tools other than Claude Code", () => {
  test("split by tool: each tool keeps its name and color, and the Tools table matches the API", async ({
    page,
  }) => {
    await logIn(page);
    // "Tool" appears once the data shows a second tool.
    const toolOption = page
      .locator("label")
      .filter({ has: page.locator('input[name="by"][value="tool"]') });
    await expect(toolOption).toBeVisible();
    await toolOption.click();
    await expect(page).toHaveURL(/by=tool/);
    await expect(page.getByRole("heading", { name: "Daily tokens by tool" })).toBeVisible();
    const legend = page.locator(".legend");
    for (const name of ["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Kimi"]) {
      await expect(legend.getByText(name, { exact: true })).toBeVisible();
    }

    const api = await page.evaluate(async () => {
      const s = await (await fetch("/api/summary?days=30")).json();
      const totals: Record<string, number> = {};
      for (const r of s.by_day_source) {
        totals[r.source] =
          (totals[r.source] ?? 0) +
          r.input_tokens +
          r.output_tokens +
          r.cache_creation_tokens +
          r.cache_read_tokens;
      }
      return { tools: s.tools as string[], totals };
    });
    expect(api.tools).toEqual(["claude", "codex", "gemini", "opencode", "kimi"]);
    const names: Record<string, string> = {
      claude: "Claude Code",
      codex: "Codex",
      gemini: "Gemini CLI",
      opencode: "OpenCode",
      kimi: "Kimi",
    };
    const table = page
      .locator(".card")
      .filter({ has: page.getByRole("heading", { name: "Tools" }) });
    for (const [id, total] of Object.entries(api.totals)) {
      const row = table.locator("tbody tr").filter({ hasText: names[id] ?? id });
      // Total tokens is the sixth column.
      await expect(row.locator("td").nth(4)).toHaveText(
        new Intl.NumberFormat("en-US").format(total),
      );
      await expect(row.locator(".swatch")).toHaveClass(new RegExp(`s${api.tools.indexOf(id) + 1}`));
    }

    // Reloading keeps the split; models of all tools are grouped into families.
    await page.reload();
    await expect(page.locator('input[name="by"][value="tool"]')).toBeChecked();
    await choose(page, "by", "model");
    await expect(page.locator('input[name="by"][value="model"]')).toBeChecked();
    for (const family of ["Opus", "Sonnet", "Haiku", "Mythos", "GPT", "Gemini", "Kimi"]) {
      await expect(legend.getByText(family, { exact: true })).toBeVisible();
    }
    await expect(legend.getByText("Other models")).toHaveCount(0);
  });

  test("the Machines page lists each machine's tools", async ({ page }) => {
    await logIn(page);
    await page.getByRole("link", { name: "Machines" }).first().click();
    const row = (name: string) => page.locator("tbody tr").filter({ hasText: name });
    await expect(row("Office PC")).toContainText("Claude Code, Codex");
    await expect(row("Laptop")).toContainText("Claude Code, Gemini CLI");
    await expect(row("Build server")).toContainText("Claude Code");
    await expect(page.getByRole("columnheader", { name: "Tools" })).toBeVisible();
  });
});

test("Settings checks for updates on request and says when GitHub couldn't be reached", async ({
  page,
}) => {
  await logIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  const card = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Version" }) });
  const status = card.getByRole("status");
  const check = card.getByRole("button", { name: "Check for updates" });

  try {
    await check.click();
    await expect(status).toContainText("It's up to date.");
    await expect(status).toContainText("Last checked just now.");

    demo.github.reachable = false;
    await check.click();
    await expect(status).toContainText(
      "Couldn't check for updates: GitHub answered with an error (HTTP 503).",
    );
    await expect(status).toContainText("Last tried just now.");
    await expect(status).not.toContainText("up to date");
    await expect(check).not.toHaveAttribute("aria-disabled");
    await expect(check).toBeFocused(); // the result is announced; focus stays put

    demo.github.reachable = true;
    demo.github.latest = "9.9.9";
    await check.click();
    await expect(status).toContainText("Version 9.9.9 is available.");
    await expect(status).toContainText("Last checked just now.");
    await test
      .info()
      .attach("settings", { body: await card.screenshot(), contentType: "image/png" });

    // The result is kept: a reload shows it without asking GitHub again.
    demo.github.reachable = false;
    await page.reload();
    await expect(status).toContainText("Version 9.9.9 is available.");
    await expect(status).not.toContainText("Couldn't check");
  } finally {
    demo.github.reachable = true;
    demo.github.latest = "0.1.0-demo";
    await check.click();
    await expect(status).toContainText("It's up to date.");
  }
});

test("long periods: weeks that add up, All from the first usage, refresh every 10 minutes", async ({
  page,
}) => {
  await page.clock.install();
  await logIn(page);
  const today = await dashboardToday(page);
  await page.goto(new URL("/?range=365", demo.url).href);
  await expect(page.locator("#chart-title")).toHaveText("Weekly tokens by machine");
  await expect(tile(page, "Tokens")).toHaveText(
    compact(await apiTokens(page, addDays(today, -364), today)),
  );
  await page.getByRole("button", { name: "Show as table" }).click();
  await expect(page.locator(".chart tbody th").first()).toHaveText(/^Week of /);
  await page.getByRole("button", { name: "Show as chart" }).click();

  // A long period refreshes every 10 minutes; up to 92 days, every minute.
  const loads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/summary?")) loads.push(r.url());
  });
  await page.clock.runFor(5 * 60_000);
  expect(loads).toEqual([]);
  await page.clock.runFor(5.5 * 60_000);
  await expect.poll(() => loads.length).toBe(1);
  expect(loads[0]).toContain("days=365");
  await choose(page, "range", "30");
  await expect(page.locator("#chart-title")).toHaveText("Daily tokens by machine");
  expect(loads).toHaveLength(2);
  await page.clock.runFor(2 * 60_000);
  await expect.poll(() => loads.length).toBeGreaterThanOrEqual(3);
  expect(loads[2]).toContain("days=30");

  // All starts at the first day with usage.
  await page.goto(new URL("/?range=all", demo.url).href);
  const first = await page.evaluate(
    async () => (await (await fetch("/api/summary?all=1")).json()).from as string,
  );
  expect(first < addDays(today, -60)).toBe(true);
  await expect(page.locator("#tz-note")).toHaveText(
    new RegExp(`^${formatDay(first, "long")} – ${formatDay(today, "long")}`),
  );
});

test("model families keep their colors in every period", async ({ page }) => {
  await logIn(page);
  /** Each legend entry's color, after loading the overview for a period. */
  const colors = async (range: string) => {
    await page.goto(new URL(`/?range=${range}&by=model`, demo.url).href);
    await expect(page.locator(".legend-item").first()).toBeVisible();
    return page
      .locator(".legend-item")
      .evaluateAll((items) =>
        Object.fromEntries(
          items.map((i) => [
            i.textContent?.trim() ?? "",
            [...(i.querySelector(".swatch")?.classList ?? [])].find((c) => c !== "swatch"),
          ]),
        ),
      );
  };
  const ninety = await colors("90");
  expect(ninety.Kimi).toMatch(/^s\d$/);
  expect(ninety.Mythos).toMatch(/^s\d$/);
  for (const range of ["30", "7"]) {
    for (const [family, color] of Object.entries(await colors(range))) {
      expect(color, `${family} in ${range} days`).toBe(ninety[family]);
    }
  }
});

test.describe("filters", () => {
  const filterButton = (page: Page, name: string) =>
    page.getByRole("button", { name: new RegExp(`^${name} `) });
  const openFilter = async (page: Page, name: string) => {
    await filterButton(page, name).click();
    const list = page.getByRole("dialog", { name: `Filter by ${name.toLowerCase()}` });
    await expect(list).toBeVisible();
    return list;
  };
  /** All tokens in the last 30 days, from the API, for rows the test picks. */
  const apiTokens30 = (page: Page, by: "machine" | "source" | "model", keep: string[]) =>
    page.evaluate(
      async ([key, values]) => {
        const s = await (await fetch("/api/summary?days=30")).json();
        const rows =
          key === "machine"
            ? s.by_day_machine
            : key === "source"
              ? s.by_day_source
              : s.by_day_model;
        const field = key === "machine" ? "machine_id" : key;
        let total = 0;
        for (const r of rows) {
          if ((values as string[]).includes(r[field])) {
            total +=
              r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
          }
        }
        return total;
      },
      [by, keep] as const,
    );
  const machineId = (page: Page, name: string) =>
    page.evaluate(
      async (n) =>
        (await (await fetch("/api/machines")).json()).machines.find(
          (m: { name: string }) => m.name === n,
        ).id as string,
      name,
    );

  test("pick machines and tools; totals follow; reload and Back keep up", async ({ page }) => {
    await logIn(page);
    await expect(filterButton(page, "Machines")).toHaveText(/All/);

    let list = await openFilter(page, "Machines");
    await list.getByRole("checkbox", { name: "Office PC" }).check();
    await list.getByRole("checkbox", { name: "Home PC" }).check();
    await expect(page).toHaveURL(/machine=/);
    await expect(list.getByRole("checkbox", { name: "All machines" })).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(filterButton(page, "Machines")).toBeFocused();
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);
    const office = await machineId(page, "Office PC");
    const home = await machineId(page, "Home PC");
    await expect(tile(page, "Tokens")).toHaveText(
      compact(await apiTokens30(page, "machine", [office, home])),
    );
    await expect(tile(page, "Machines reporting")).toHaveText(/of 2$/);
    // The chart keeps to the filter when it redraws for a new width.
    const legendItems = page.locator(".legend .legend-item");
    await expect(legendItems).toHaveText(["Office PC", "Home PC"]);
    const size = page.viewportSize();
    if (size) {
      const svg = page.locator(".chart svg");
      const before = await svg.getAttribute("viewBox");
      await page.setViewportSize({ width: 800, height: size.height });
      await expect(svg).not.toHaveAttribute("viewBox", before ?? "");
      await expect(legendItems).toHaveText(["Office PC", "Home PC"]);
      await page.setViewportSize(size);
    }

    // Tools too: both filters apply. Kimi is offered because Home PC used it.
    list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Kimi" }).check();
    await page.mouse.click(5, 5);
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);
    const both = await page.evaluate(
      async ([id]) => {
        const s = await (await fetch("/api/summary?days=30")).json();
        let total = 0;
        for (const r of s.by_machine_source) {
          if (r.source === "kimi" && r.machine_id === id) {
            total +=
              r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
          }
        }
        return total;
      },
      [home],
    );
    await expect(tile(page, "Tokens")).toHaveText(compact(both)); // Kimi only runs on Home PC

    await page.reload();
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);
    await expect(tile(page, "Tokens")).toHaveText(compact(both));

    // Back undoes one opening of a dropdown at a time.
    await page.goBack();
    await expect(filterButton(page, "Tools")).toHaveText(/All/);
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);
    await page.goForward();
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page).not.toHaveURL(/tool=|machine=/);
    await expect(filterButton(page, "Tools")).toHaveText(/All/);
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeHidden();
  });

  test("models: a family, or exact models within one", async ({ page }) => {
    await logIn(page);
    const list = await openFilter(page, "Models");
    await list.getByRole("checkbox", { name: "Kimi" }).check();
    await expect(page).toHaveURL(/family=kimi/);

    // Sonnet is used through Claude Code and OpenCode: pick only OpenCode's.
    await list.getByRole("button", { name: /^Sonnet: show its 2 models/ }).click();
    await list.getByRole("checkbox", { name: "anthropic/claude-sonnet-5-5" }).check();
    const sonnet = list.getByRole("checkbox", { name: "Sonnet", exact: true });
    await expect(sonnet).not.toBeChecked();
    expect(await sonnet.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page).toHaveURL(/model=anthropic%2Fclaude-sonnet-5-5/);
    await page.keyboard.press("Escape");

    const want = await apiTokens30(page, "model", ["k3", "anthropic/claude-sonnet-5-5"]);
    await expect(tile(page, "Tokens")).toHaveText(compact(want));
    await choose(page, "by", "model");
    const legend = page.locator(".legend");
    await expect(legend.locator(".legend-item")).toHaveText(["Sonnet", "Kimi"]);
    await expect(filterButton(page, "Models")).toHaveText(/^anthropic\/claude-sonnet-5-5, Kimi/);
  });

  test("works with the keyboard alone", async ({ page }) => {
    await logIn(page);
    await filterButton(page, "Tools").focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("dialog", { name: "Filter by tools" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("checkbox", { name: "All tools" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(list.getByRole("checkbox", { name: "Claude Code" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/tool=claude/);
    await page.keyboard.press("Escape");
    await expect(filterButton(page, "Tools")).toBeFocused();
    await expect(filterButton(page, "Tools")).toHaveText(/Claude Code/);
  });

  test("the date picker's dots follow the filters", async ({ page }) => {
    await logIn(page);
    const list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Kimi" }).check();
    await page.keyboard.press("Escape");
    await page.locator(".range-button").click();
    const shown = await page
      .locator(".drp-day")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.date ?? ""));
    const kimiDays = await page.evaluate(
      async ([a, b]) =>
        (await (await fetch(`/api/usage-days?from=${a}&to=${b}&source=kimi`)).json())
          .days as string[],
      [shown[0], shown.at(-1)],
    );
    const allDays = await page.evaluate(
      async ([a, b]) =>
        (await (await fetch(`/api/usage-days?from=${a}&to=${b}`)).json()).days as string[],
      [shown[0], shown.at(-1)],
    );
    expect(kimiDays.length).toBeGreaterThan(0);
    expect(kimiDays.length).toBeLessThan(allDays.length);
    await expect
      .poll(() =>
        page
          .locator(".drp-day.has-usage")
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.date)),
      )
      .toEqual(kimiDays);
  });

  /** What the lists should offer, worked out from the API's rows for the last 30 days. */
  async function expectedOffers(
    page: Page,
    keep: { machines?: string[]; tools?: string[]; families?: string[] },
  ) {
    const d = await page.evaluate(async () => {
      const s = await (await fetch("/api/summary?days=30&detail=1")).json();
      const m = await (await fetch("/api/machines")).json();
      const names = Object.fromEntries(
        m.machines.map((x: { id: string; name: string }) => [x.id, x.name]),
      );
      return {
        rows: (s.detail.rows as number[][]).map((r) => ({
          machine: names[s.detail.machines[r[1] as number]] as string,
          tool: s.detail.sources[r[2] as number] as string,
          model: s.detail.models[r[3] as number] as string,
          tokens: (r[4] as number) + (r[5] as number) + (r[6] as number) + (r[7] as number),
        })),
      };
    });
    const okM = (x: string) => !keep.machines || keep.machines.includes(x);
    const okT = (x: string) => !keep.tools || keep.tools.includes(x);
    const okK = (x: string) => !keep.families || keep.families.includes(modelFamily(x).label);
    const machines = new Set<string>();
    const tools = new Set<string>();
    const families = new Set<string>();
    for (const r of d.rows) {
      if (r.tokens === 0) continue;
      if (okT(r.tool) && okK(r.model)) machines.add(r.machine);
      if (okM(r.machine) && okK(r.model)) tools.add(toolName(r.tool));
      if (okM(r.machine) && okT(r.tool)) families.add(modelFamily(r.model).label);
    }
    return {
      machines: [...machines].sort(),
      tools: [...tools].sort(),
      families: [...families].sort(),
    };
  }

  /** The items a list shows (top level only; families for Models), sorted. */
  async function listed(page: Page, name: string) {
    const list = await openFilter(page, name);
    const items = await list
      .locator(".ms-list > ul > li")
      .evaluateAll((lis) =>
        lis.map((li) => li.querySelector("label span")?.textContent?.trim() ?? ""),
      );
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    return items.sort();
  }

  test("each list only offers what matches the picks in the others", async ({ page }) => {
    await logIn(page);
    const all = await expectedOffers(page, {});
    expect(await listed(page, "Tools")).toEqual(all.tools);

    // Laptop: only its tools and model families.
    let list = await openFilter(page, "Machines");
    await list.getByRole("checkbox", { name: "Laptop" }).check();
    // A list isn't narrowed by its own picks.
    await expect(list.getByRole("checkbox", { name: "Office PC" })).toBeVisible();
    await page.keyboard.press("Escape");
    const laptop = await expectedOffers(page, { machines: ["Laptop"] });
    expect(laptop.tools).toEqual(["Claude Code", "Gemini CLI"]);
    expect(await listed(page, "Tools")).toEqual(laptop.tools);
    expect(await listed(page, "Models")).toEqual(laptop.families);
    expect(laptop.families).not.toContain("Kimi");

    // Then Gemini CLI: the machines that used it.
    list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Gemini CLI" }).check();
    await page.keyboard.press("Escape");
    const gemini = await expectedOffers(page, { tools: ["gemini"] });
    expect(await listed(page, "Machines")).toEqual(gemini.machines);

    // The same picks in the other order give the same lists.
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Gemini CLI" }).check();
    await page.keyboard.press("Escape");
    expect(await listed(page, "Machines")).toEqual(gemini.machines);

    // A machine that used only Claude Code: the Tools list stays, with one item.
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    list = await openFilter(page, "Machines");
    await list.getByRole("checkbox", { name: "Build server" }).check();
    await page.keyboard.press("Escape");
    await expect(filterButton(page, "Tools")).toBeVisible();
    expect(await listed(page, "Tools")).toEqual(["Claude Code"]);

    // Models: a family's list only holds its matching models.
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "OpenCode" }).check();
    await page.keyboard.press("Escape");
    list = await openFilter(page, "Models");
    await list.getByRole("button", { name: /^Sonnet: show its 1 model$/ }).click();
    await expect(list.getByRole("checkbox", { name: "anthropic/claude-sonnet-5-5" })).toBeVisible();
    await expect(
      list.getByRole("checkbox", { name: "claude-sonnet-5-5", exact: true }),
    ).toHaveCount(0);
    // Ticking the only listed Sonnet model picks just that model, not the hidden one too.
    await list.getByRole("checkbox", { name: "anthropic/claude-sonnet-5-5" }).check();
    await expect(page).toHaveURL(/model=anthropic%2Fclaude-sonnet-5-5/);
    await expect(page).not.toHaveURL(/family=sonnet/);
    await page.keyboard.press("Escape");
  });

  test("a pick with no usage in a new period stays, marked, until unticked", async ({ page }) => {
    await logIn(page);
    // Kimi is only on Home PC, which joined 20 days ago.
    let list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Kimi" }).check();
    await page.keyboard.press("Escape");
    const today = await dashboardToday(page);
    await page.locator(".range-button").click();
    const dialog = page.getByRole("dialog", { name: "Choose dates" });
    await field(dialog, "From").fill(addDays(today, -60));
    await field(dialog, "To").fill(addDays(today, -40));
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("Nothing matches these filters in this period")).toBeVisible();

    list = await openFilter(page, "Tools");
    const kimi = list.getByRole("checkbox", { name: /Kimi/ });
    await expect(kimi).toBeChecked();
    await expect(list.locator(".ms-option.stale")).toContainText("Kimino usage in this period");
    await kimi.uncheck();
    await expect(list.getByRole("checkbox", { name: /Kimi/ })).toBeVisible(); // until the list reopens
    await page.keyboard.press("Escape");
    list = await openFilter(page, "Tools");
    await expect(list.getByRole("checkbox", { name: /Kimi/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".legend-item").first()).toBeVisible();
  });

  test("filters that match nothing say so", async ({ page }) => {
    await logIn(page);
    // Codex only runs on Office PC, so the lists never offer Codex with
    // Laptop; a shared address can still ask for it.
    const laptop = await machineId(page, "Laptop");
    await page.goto(new URL(`/?range=30&tool=codex&machine=${laptop}`, demo.url).href);
    await expect(page.getByText("Nothing matches these filters in this period")).toBeVisible();
    await expect(tile(page, "Tokens")).toHaveText("0");
    // Both picks are kept, marked, so it's clear why.
    let list = await openFilter(page, "Tools");
    await expect(list.getByRole("checkbox", { name: /Codex/ })).toBeChecked();
    await expect(list.locator(".ms-option.stale")).toContainText(
      "no usage with your other filters",
    );
    await page.keyboard.press("Escape");
    list = await openFilter(page, "Models");
    await expect(
      list.getByText("Nothing was used with your other filters in this period."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".empty").getByRole("button", { name: "Clear filters" }).click();
    await expect(filterButton(page, "Tools")).toHaveText(/All/);
    await expect(page.locator(".legend-item").first()).toBeVisible();
  });
});

test.describe("access control", () => {
  /** Tokens per machine name in the last 30 days, as the admin sees them. */
  async function tokensByMachine(page: Page): Promise<Record<string, number>> {
    return page.evaluate(async () => {
      const [s, m] = await Promise.all([
        fetch("/api/summary?days=30").then((r) => r.json()),
        fetch("/api/machines").then((r) => r.json()),
      ]);
      const names = Object.fromEntries(
        m.machines.map((x: { id: string; name: string }) => [x.id, x.name]),
      );
      const out: Record<string, number> = {};
      for (const r of s.by_day_machine) {
        const name = names[r.machine_id] as string;
        out[name] =
          (out[name] ?? 0) +
          r.input_tokens +
          r.output_tokens +
          r.cache_creation_tokens +
          r.cache_read_tokens;
      }
      return out;
    });
  }
  const navLinks = (page: Page) =>
    page.getByRole("navigation", { name: "Main" }).getByRole("link").allInnerTexts();
  const machineNames = async (page: Page) => {
    await page.goto(new URL("/machines", demo.url).href);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    return (await page.locator("tbody th .name-cell").allInnerTexts()).map((t) => t.trim()).sort();
  };

  const roles: [string, string[], string[]][] = [
    [
      "sam",
      ["Overview", "Machines", "Settings"],
      ["Build server", "Home PC", "Laptop", "Office PC"],
    ],
    ["morgan", ["Overview", "Machines", "Approvals", "Users"], ["Build server", "Office PC"]],
    ["riley", ["Overview", "Machines"], ["Office PC"]],
    ["casey", ["Overview", "Machines"], ["Laptop"]],
  ];
  for (const [user, nav, machines] of roles) {
    test(`${user} sees only their pages and machines`, async ({ page }) => {
      await logIn(page);
      const all = await tokensByMachine(page);
      await page.getByRole("button", { name: "Log out" }).click();
      await logIn(page, user);
      expect(await navLinks(page)).toEqual(nav);
      const want = machines.reduce((n, m) => n + (all[m] ?? 0), 0);
      await expect(tile(page, "Tokens")).toHaveText(compact(want));
      await expect(tile(page, "Machines reporting")).toHaveText(
        new RegExp(`of ${machines.length}$`),
      );
      expect(await machineNames(page)).toEqual(machines);
      if (!nav.includes("Settings")) {
        await page.goto(new URL("/settings", demo.url).href);
        await expect(page.getByRole("heading", { name: "Not available to you" })).toBeVisible();
      }
    });
  }

  test("the Overview filters and splits by department", async ({ page }) => {
    await logIn(page);
    const all = await tokensByMachine(page);
    await page.goto(new URL("/?range=30", demo.url).href);
    const button = page.getByRole("button", { name: /^Departments / });
    await button.click();
    const list = page.getByRole("dialog", { name: "Filter by departments" });
    await expect(list.locator(".ms-list > ul > li")).toHaveText([
      "Design",
      "Engineering",
      "No department",
    ]);
    await list.getByRole("checkbox", { name: "Engineering" }).check();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/department=/);
    await expect(tile(page, "Tokens")).toHaveText(
      compact((all["Office PC"] ?? 0) + (all["Build server"] ?? 0)),
    );
    // The machines list narrows to the department's.
    await page.getByRole("button", { name: /^Machines / }).click();
    await expect(
      page.getByRole("dialog", { name: "Filter by machines" }).locator(".ms-list > ul > li"),
    ).toHaveText(["Build server", "Office PC"]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await choose(page, "by", "department");
    await expect(page.locator("#chart-title")).toHaveText("Daily tokens by department");
    expect((await page.locator(".legend .legend-item").allInnerTexts()).sort()).toEqual([
      "Design",
      "Engineering",
      "No department",
    ]);
  });

  test("managers approve into their department, with an owner from it", async ({ page }) => {
    await logIn(page, "morgan");
    await page.goto(new URL("/approve", demo.url).href);
    await expect(page.getByRole("heading", { name: "Waiting to join" })).toHaveCount(0);
    const department = page.getByLabel("Department");
    await expect(department.locator("option")).toHaveText(["Engineering"]);
    const owner = page.getByLabel("Owner");
    await expect(owner.locator("option")).toHaveText([
      "Nobody: a shared machine",
      "morgan",
      "riley",
    ]);
    await owner.selectOption({ label: "riley" });
    await page.getByLabel("Code shown on the machine").fill("K7QX82MD");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Approved Studio PC")).toBeVisible();
    const [row] = (
      await demo.db
        .prepare(
          `SELECT p.status, d.name AS department, u.username AS owner FROM pairing_requests p
           JOIN departments d ON d.id = p.department_id JOIN users u ON u.id = p.owner_id
          WHERE p.user_code = 'K7QX-82MD'`,
        )
        .all()
    ).results;
    expect(row).toEqual({ status: "approved", department: "Engineering", owner: "riley" });
  });

  test("managers add and manage the people in their department", async ({ page }) => {
    await logIn(page, "morgan");
    await page.goto(new URL("/users", demo.url).href);
    const rows = page.locator("tbody tr");
    await expect(rows.locator("th")).toHaveText(["morgan (you)", "riley"]);
    await expect(rows.filter({ hasText: "riley" })).toContainText("Member of Engineering");

    await page.getByLabel("Username").fill("taylor");
    await page.getByLabel("Role in Engineering").selectOption("member");
    await page.getByRole("button", { name: "Add user…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Temporary password").fill("a-temporary-password-1");
    await dialog.getByLabel("Repeat it").fill("a-temporary-password-1");
    await dialog.getByRole("button", { name: "Set password" }).click();
    const taylor = rows.filter({ hasText: "taylor" });
    await expect(taylor).toContainText("Member of Engineering");

    await taylor.getByRole("button", { name: "Access…" }).click();
    await page.getByRole("dialog").getByLabel("Role in Engineering").selectOption("viewer");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(taylor).toContainText("Viewer of Engineering");

    await taylor.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(taylor).toHaveCount(0);
  });

  test("the access form offers the department roles that still mean something", async ({
    page,
  }) => {
    await logIn(page);
    await page.goto(new URL("/users", demo.url).href);
    const form = page.locator("form").filter({ has: page.getByLabel("Username") });
    const role = form.getByLabel("Dashboard-wide role");
    const engineering = form.getByLabel("Role in Engineering");
    // With departments, new people start without a dashboard-wide role.
    await expect(role).toHaveValue("");
    await expect(engineering.locator("option")).toHaveText([
      "No role",
      "Member",
      "Viewer",
      "Manager",
    ]);
    await engineering.selectOption("manager");
    // A viewer of everything already sees every machine.
    await role.selectOption("viewer");
    await expect(engineering.locator("option")).toHaveText([
      "No role",
      "Member: can own its machines",
      "Manager",
    ]);
    await expect(engineering).toHaveValue("manager");
    // Admins need no department roles.
    await role.selectOption("admin");
    await expect(engineering).toBeHidden();
    await expect(form.getByText("Admins see and manage every department")).toBeVisible();
    await role.selectOption("");
    await expect(engineering).toHaveValue("manager");
    // Someone with no access at all isn't added.
    await engineering.selectOption("");
    await form.getByLabel("Username").fill("nobody-at-all");
    await form.getByRole("button", { name: "Add user…" }).click();
    await expect(
      form.getByText("Give them a dashboard-wide role or a role in a department."),
    ).toBeVisible();
  });

  test("admins manage departments, and machines' departments and owners", async ({ page }) => {
    await logIn(page);
    await page.goto(new URL("/departments", demo.url).href);
    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: "Engineering" }).locator("td")).toHaveText([
      "2",
      "2",
      /Rename/,
    ]);
    await page.getByRole("button", { name: "Add a department…" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Support");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const support = rows.filter({ hasText: "Support" });
    await expect(support).toBeVisible();
    await support.getByRole("button", { name: "Rename" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Customer support");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(rows.filter({ hasText: "Customer support" })).toBeVisible();
    await rows
      .filter({ hasText: "Customer support" })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(rows.filter({ hasText: "Customer support" })).toHaveCount(0);

    // Machines: department and owner columns, search, a department filter, editing.
    await page.goto(new URL("/machines", demo.url).href);
    const machine = (name: string) => page.locator("tbody tr").filter({ hasText: name });
    await expect(machine("Office PC").locator("td").nth(0)).toHaveText("Engineering");
    await expect(machine("Office PC").locator("td").nth(1)).toHaveText("riley");
    await expect(machine("Home PC").locator("td").nth(1)).toHaveText("Shared");
    await page.getByLabel("Search machines").fill("lap");
    await expect(page.locator("tbody th .name-cell")).toHaveText(["Laptop"]);
    await page.getByLabel("Search machines").fill("");
    await page.getByLabel("Department", { exact: true }).selectOption({ label: "Engineering" });
    await expect(page.locator("tbody th .name-cell")).toHaveText(["Build server", "Office PC"]);
    await page.getByRole("button", { name: "Tokens (30 days)" }).click();
    await expect(page.locator("th[aria-sort]")).toHaveAttribute("aria-sort", "descending");

    await machine("Build server").getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog");
    // People in Engineering, and admins, who can own any machine.
    await expect(edit.getByLabel("Owner").locator("option")).toHaveText([
      "Nobody: a shared machine",
      "demo",
      "morgan",
      "riley",
    ]);
    await edit.getByLabel("Owner").selectOption({ label: "morgan" });
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(machine("Build server").locator("td").nth(1)).toHaveText("morgan");
    await machine("Build server").getByRole("button", { name: "Edit" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Owner")
      .selectOption({ label: "Nobody: a shared machine" });
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(machine("Build server").locator("td").nth(1)).toHaveText("Shared");
  });
});

test.describe("prices", () => {
  /** Each model's tokens and ccusage's cost in the last 30 days, and the list prices. */
  async function usageAndPrices(page: Page) {
    return page.evaluate(async () => {
      const s = await (await fetch("/api/summary?days=30")).json();
      const p = await (await fetch("/api/prices")).json();
      return { rows: s.by_day_model, prices: p.models, mode: s.pricing.mode };
    });
  }
  type Rows = Awaited<ReturnType<typeof usageAndPrices>>;
  /** The total cost the Overview should show, worked out here from tokens and prices. */
  function expectedCost(d: Rows, custom: Record<string, number[]> = {}) {
    let total = 0;
    for (const r of d.rows) {
      const m = d.prices.find((x: { model: string }) => x.model === r.model);
      const list = m?.models_dev ?? m?.litellm;
      const p =
        custom[r.model] ??
        (list ? [list.input, list.output, list.cache_write, list.cache_read] : null);
      total += p
        ? (r.input_tokens * p[0] +
            r.output_tokens * p[1] +
            r.cache_creation_tokens * p[2] +
            r.cache_read_tokens * p[3]) /
          1e6
        : r.cost_usd;
    }
    return `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  test("admins switch to list prices or their own, and every cost follows", async ({ page }) => {
    await logIn(page);
    const before = await usageAndPrices(page);
    expect(before.mode).toBe("ccusage");
    await page.goto(new URL("/settings", demo.url).href);
    const card = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { name: "Prices" }) });
    await expect(card.locator("table")).toHaveCount(0);

    // Price lists.
    await card.locator("label").filter({ hasText: "Price lists" }).click();
    await expect(card.locator("tbody tr").filter({ hasText: "k3" })).toContainText(
      "moonshotai/kimi-k3",
    );
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Prices saved")).toBeVisible();
    await page.goto(new URL("/?range=30", demo.url).href);
    await expect(tile(page, "Estimated cost")).toHaveText(expectedCost(before));
    await expect(page.locator(".tile").filter({ hasText: "Estimated cost" })).toContainText(
      "makers' list prices",
    );
    const models = page
      .locator(".card")
      .filter({ has: page.getByRole("heading", { name: "Models", exact: true }) });
    await expect(models.locator("tbody tr").filter({ hasText: "claude-mythos-5-1" })).toContainText(
      "LiteLLM price",
    );
    await expect(models.locator("tbody tr").filter({ hasText: "gemini-3-pro" })).toContainText(
      "Priced by ccusage",
    );

    // Custom: one model's own price; the rest stay on the lists.
    await page.goto(new URL("/settings", demo.url).href);
    await card.locator("label").filter({ hasText: "Custom" }).click();
    const k3 = [1, 2, 3, 4];
    for (const [i, label] of ["Input", "Output", "Cache write", "Cache read"].entries()) {
      await card.getByLabel(`${label} price for k3`).fill(String(k3[i]));
    }
    await card.getByLabel("Input price for gemini-3-pro").fill("1");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("Fill in all four prices for gemini-3-pro")).toBeVisible();
    await card.getByLabel("Input price for gemini-3-pro").fill("");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Prices saved")).toBeVisible();
    await page.goto(new URL("/?range=30", demo.url).href);
    await expect(tile(page, "Estimated cost")).toHaveText(expectedCost(before, { k3 }));
    await expect(models.locator("tbody tr").filter({ hasText: "k3" })).toContainText(
      "Custom price",
    );

    // Back to ccusage's costs, as other tests expect.
    await page.goto(new URL("/settings", demo.url).href);
    await card.locator("label").filter({ hasText: "ccusage" }).click();
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Prices saved")).toBeVisible();
    await page.goto(new URL("/?range=30", demo.url).href);
    const total = before.rows.reduce((n: number, r: { cost_usd: number }) => n + r.cost_usd, 0);
    await expect(tile(page, "Estimated cost")).toHaveText(
      `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
  });

  test("viewers see the prices but can't change them", async ({ page }) => {
    await logIn(page, "sam");
    await page.goto(new URL("/settings", demo.url).href);
    const card = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { name: "Prices" }) });
    await expect(card.getByText("Only admins can change this.")).toBeVisible();
    await expect(card.getByRole("radio", { name: "Custom" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Save" })).toHaveCount(0);
  });
});
