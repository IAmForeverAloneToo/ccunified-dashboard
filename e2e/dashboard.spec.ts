/**
 * The dashboard's date range picker, in Chrome and Firefox, against the demo
 * data: 90 days of usage for four machines, with some days missing.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
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

async function logIn(page: Page) {
  await page.goto(new URL("/login", demo.url).href);
  await page.getByLabel("Username").fill("demo");
  await page.getByLabel("Password").fill("demo-password");
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

  test("pick tools and machines; totals follow; reload and Back keep up", async ({ page }) => {
    await logIn(page);
    await expect(filterButton(page, "Tools")).toHaveText(/All/);

    let list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Kimi" }).check();
    await expect(page).toHaveURL(/tool=kimi/);
    await expect(list.getByRole("checkbox", { name: "All tools" })).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(filterButton(page, "Tools")).toBeFocused();
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);
    await expect(tile(page, "Tokens")).toHaveText(
      compact(await apiTokens30(page, "source", ["kimi"])),
    );

    // Machines too: both filters apply.
    list = await openFilter(page, "Machines");
    await list.getByRole("checkbox", { name: "Office PC" }).check();
    await list.getByRole("checkbox", { name: "Home PC" }).check();
    await page.mouse.click(5, 5);
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);
    const home = await machineId(page, "Home PC");
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
    await expect(tile(page, "Machines reporting")).toHaveText(/of 2$/);

    await page.reload();
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);
    await expect(tile(page, "Tokens")).toHaveText(compact(both));

    // Back undoes one opening of a dropdown at a time.
    await page.goBack();
    await expect(filterButton(page, "Machines")).toHaveText(/All/);
    await expect(filterButton(page, "Tools")).toHaveText(/Kimi/);
    await page.goForward();
    await expect(filterButton(page, "Machines")).toHaveText(/Home PC, Office PC/);

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

  test("filters that match nothing say so", async ({ page }) => {
    await logIn(page);
    // Codex only runs on Office PC.
    let list = await openFilter(page, "Tools");
    await list.getByRole("checkbox", { name: "Codex" }).check();
    await page.keyboard.press("Escape");
    list = await openFilter(page, "Machines");
    await list.getByRole("checkbox", { name: "Laptop" }).check();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Nothing matches these filters in this period")).toBeVisible();
    await expect(tile(page, "Tokens")).toHaveText("0");
    await page.locator(".empty").getByRole("button", { name: "Clear filters" }).click();
    await expect(filterButton(page, "Tools")).toHaveText(/All/);
    await expect(page.locator(".legend-item").first()).toBeVisible();
  });
});
