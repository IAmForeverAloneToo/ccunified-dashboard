import { seesAll } from "../lib/access";
import {
  api,
  type Bucket,
  type Department,
  type DetailedSummary,
  getCached,
  type Machine,
  type MachinesResponse,
  type PairingRequest,
  type PriceSource,
  type PricingMode,
  type Summary,
  type Totals,
} from "../lib/api";
import { type Column, legend, renderColumns, type Series } from "../lib/chart";
import { rangePicker } from "../lib/daterange";
import { daysInclusive, formatRange, isDate, MAX_RANGE_DAYS } from "../lib/dates";
import { type Child, fill, h, s, segmented } from "../lib/dom";
import {
  allowedMachines,
  allowedModels,
  applyFilters,
  available,
  type DepartmentOf,
  type Filters,
  isFiltered,
  NO_DEPARTMENT,
  noFilters,
  readFilters,
  writeFilters,
} from "../lib/filters";
import { addDays, compactNumber, day, fullNumber, money, percent } from "../lib/format";
import { familySeries, modelFamily } from "../lib/models";
import { type Choice, type MultiSelect, multiSelect } from "../lib/multiselect";
import { seriesOf, stableSeries } from "../lib/series";
import { toolName, toolSeries } from "../lib/tools";
import type { PageContext } from "../main";

type RangeKey = "1" | "7" | "30" | "90" | "365" | "all";
/** A preset, or "custom" for dates picked in the calendar. */
type Period = RangeKey | "custom";
type SplitKey = "machine" | "department" | "model" | "tool";
type MeasureKey = "tokens" | "output" | "cost";

const RANGES: [RangeKey, string][] = [
  ["1", "Today"],
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
  ["all", "All"],
];
const SPLITS: [SplitKey, string][] = [
  ["machine", "Machine"],
  ["department", "Department"],
  ["model", "Model"],
  ["tool", "Tool"],
];
const MEASURES: [MeasureKey, string][] = [
  ["tokens", "All tokens"],
  ["output", "Output tokens"],
  ["cost", "Est. cost"],
];
const MEASURE_TITLE: Record<MeasureKey, string> = {
  tokens: "tokens",
  output: "output tokens",
  cost: "estimated cost",
};

/** What the cost tile says, by pricing mode. */
const COST_NOTE: Record<PricingMode, string> = {
  ccusage: "At API prices, not your subscription bill",
  lists: "At the makers' list prices, not your subscription bill",
  custom: "At your prices and list prices, not a bill",
};

const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  ccusage: "Priced by ccusage",
  custom: "Custom price",
  "models.dev": "models.dev price",
  litellm: "LiteLLM price",
};

/** How often the page refreshes: every minute, or every 10 minutes beyond 92 days. */
const REFRESH_MS = 60_000;
const LONG_REFRESH_MS = 10 * 60_000;

const totalTokens = (t: Totals) =>
  t.input_tokens + t.output_tokens + t.cache_creation_tokens + t.cache_read_tokens;

const measureOf: Record<MeasureKey, (t: Totals) => number> = {
  tokens: totalTokens,
  output: (t) => t.output_tokens,
  cost: (t) => t.cost_usd,
};

function emptyTotals(): Totals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
  };
}

function addInto(into: Totals, t: Totals): void {
  into.input_tokens += t.input_tokens;
  into.output_tokens += t.output_tokens;
  into.cache_creation_tokens += t.cache_creation_tokens;
  into.cache_read_tokens += t.cache_read_tokens;
  into.cost_usd += t.cost_usd;
}

// ---------- Colors that follow the entity, never its rank ----------

/**
 * Machines keep the color of their position in the order they joined
 * (oldest first), so filtering never repaints anyone. Past eight machines, the
 * newest fold into a gray "Other machines". Removed machines (their usage
 * kept) are gray "Removed machines", or part of "Other machines" when there
 * is one.
 */
export function machineSeries(machines: Machine[]): Map<string, Series> {
  const ordered = machines
    .filter((m) => m.removed_at === null)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const fold = ordered.length > 8;
  const other: Series = { id: "other", label: "Other machines", colorClass: "s-other" };
  const removed: Series = fold
    ? other
    : { id: REMOVED, label: "Removed machines", colorClass: "s-other" };
  const map = new Map<string, Series>();
  ordered.forEach((m, i) => {
    map.set(m.id, fold && i >= 7 ? other : { id: m.id, label: m.name, colorClass: `s${i + 1}` });
  });
  for (const m of machines) if (m.removed_at !== null) map.set(m.id, removed);
  return map;
}

/** The series and table row that removed machines' usage counts under. */
const REMOVED = "removed";

// ---------- Time buckets (the API picks one for the period) ----------

function bucketStart(date: string, bucket: Bucket): string {
  if (bucket === "day") return date;
  if (bucket === "month") return `${date.slice(0, 7)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // weeks start on Monday
  return addDays(date, -offset);
}

function bucketKeys(from: string, to: string, bucket: Bucket): string[] {
  const keys: string[] = [];
  let key = bucketStart(from, bucket);
  while (key <= to) {
    keys.push(key);
    if (bucket === "day") key = addDays(key, 1);
    else if (bucket === "week") key = addDays(key, 7);
    else {
      const d = new Date(`${key}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      key = d.toISOString().slice(0, 10);
    }
  }
  return keys;
}

function bucketLabels(key: string, bucket: Bucket): { label: string; title: string } {
  if (bucket === "day") return { label: day(key), title: day(key, "long") };
  if (bucket === "week") return { label: day(key), title: `Week of ${day(key, "long")}` };
  return { label: day(key, "month"), title: day(key, "month") };
}

// ---------- Page ----------

function readChoice<T extends string>(
  query: URLSearchParams,
  name: string,
  options: [T, string][],
  fallback: T,
): T {
  const v = query.get(name);
  return (options.find(([k]) => k === v)?.[0] ?? fallback) as T;
}

/** The period in the address: a preset, or range=custom&from=…&to=…. */
function readPeriod(query: URLSearchParams): { range: Period; from: string; to: string } {
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  if (
    query.get("range") === "custom" &&
    isDate(from) &&
    isDate(to) &&
    from <= to &&
    daysInclusive(from, to) <= MAX_RANGE_DAYS
  ) {
    return { range: "custom", from, to };
  }
  return { range: readChoice(query, "range", RANGES, "30"), from: "", to: "" };
}

const calendarIcon = () =>
  s(
    "svg",
    { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true" },
    s("rect", {
      x: "2",
      y: "3",
      width: "12",
      height: "11",
      rx: "2",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
    }),
    s("path", {
      d: "M2 6.5h12M5.5 1.5v3M10.5 1.5v3",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    }),
  );

export async function overviewPage(ctx: PageContext) {
  const state = {
    ...readPeriod(ctx.query),
    split: readChoice(ctx.query, "by", SPLITS, "machine"),
    measure: readChoice(ctx.query, "measure", MEASURES, "tokens"),
    tableView: false,
    filters: readFilters(ctx.query),
  };

  const banners = h("div", { class: "stack" });
  const tiles = h("div", { class: "tiles" });
  const chartTitle = h("h2");
  const chartSubtitle = h("p");
  const legendSlot = h("div");
  const chartBox = h("div", { class: "chart" });
  const tableToggle = h("button", { type: "button", class: "small" }, "Show as table");
  const breakdown = h("div", { class: "card" });
  const toolsCard = h("div", { class: "card" });
  const models = h("div", { class: "card" });

  const periodText = h("span");
  const customButton = h(
    "button",
    { type: "button", class: "range-button" },
    calendarIcon(),
    periodText,
  );
  const periodFilter = segmented<Period>("range", "Period", RANGES, state.range, (v) =>
    update({ range: v }),
  );
  periodFilter.append(customButton);
  const splitFilter = segmented("by", "Split by", SPLITS, state.split, (v) => update({ split: v }));
  // "Tool" is offered once a second tool reports usage.
  const toolOption = splitFilter
    .querySelector<HTMLInputElement>('input[value="tool"]')
    ?.closest("label");
  if (toolOption) toolOption.hidden = state.split !== "tool";
  // "Department" too, once machines in the period belong to more than one.
  const departmentOption = splitFilter
    .querySelector<HTMLInputElement>('input[value="department"]')
    ?.closest("label");
  if (departmentOption) departmentOption.hidden = state.split !== "department";
  const filters = h(
    "div",
    { class: "filters", role: "group", "aria-label": "Filters" },
    periodFilter,
    splitFilter,
    segmented("measure", "Show", MEASURES, state.measure, (v) => update({ measure: v })),
  );
  // Machines, Tools and Models dropdowns, filled in once the data is known.
  const limits = h("div", { class: "filters", role: "group", "aria-label": "Limit to" });

  ctx.main.append(
    h(
      "div",
      { class: "page-head" },
      h("div", null, h("h1", null, "Overview"), h("p", { id: "tz-note" }, "")),
    ),
    filters,
    limits,
    banners,
    tiles,
    h(
      "section",
      { class: "card", "aria-labelledby": "chart-title" },
      h(
        "div",
        { class: "card-head" },
        h("div", null, Object.assign(chartTitle, { id: "chart-title" }), chartSubtitle),
        tableToggle,
      ),
      legendSlot,
      chartBox,
    ),
    breakdown,
    toolsCard,
    models,
  );

  let summary: DetailedSummary | undefined;
  /** When the data was last asked for. */
  let loadedAt = 0;
  let machines: Machine[] = [];
  let machineById = new Map<string, Machine>();
  let pending: PairingRequest[] = [];
  /** Every department the user can see, oldest first (for their colors). */
  let departments: Department[] = [];

  const departmentOf: DepartmentOf = (id) => machineById.get(id)?.department?.id ?? NO_DEPARTMENT;
  const departmentName = (id: string) =>
    id === NO_DEPARTMENT
      ? "No department"
      : (machines.find((m) => m.department?.id === id)?.department?.name ??
        departments.find((d) => d.id === id)?.name ??
        "Unknown department");
  /** The departments of the machines with usage in the period. */
  const departmentsInPeriod = () =>
    new Set((summary?.detail.machines ?? []).map((m) => departmentOf(m)));

  // ---------- Filters: limit everything to some machines, tools and models ----------

  /** Ids in a list, then any others seen in the data or the filters, once each. */
  const known = (first: string[], ...more: string[][]) => [...new Set([...first, ...more.flat()])];
  const knownTools = () =>
    known(summary?.tools ?? [], summary?.detail?.sources ?? [], state.filters.tools);
  const knownModels = () =>
    known(summary?.models ?? [], summary?.detail?.models ?? [], state.filters.models);

  // Each list offers only what was used, in the period shown, together with
  // the picks in the other lists. Picks that no longer match stay listed,
  // ticked and marked, so it's clear why the page is empty.
  const offered = () => (summary ? available(summary, state.filters, departmentOf) : null);
  const staleNote = (othersFiltered: boolean) =>
    othersFiltered ? "no usage with your other filters" : "no usage in this period";
  const notes = (...parts: (string | false)[]) => parts.filter(Boolean).join(" · ") || undefined;
  const nothingLeft = "Nothing was used with your other filters in this period.";

  function setFilters(change: Partial<Filters>, push: boolean) {
    state.filters = { ...state.filters, ...change };
    writeUrl(push);
    draw();
  }

  const departmentSelect = multiSelect({
    label: "Departments",
    allLabel: "All departments",
    emptyText: nothingLeft,
    choices: () => {
      const f = state.filters;
      const ok = offered()?.departments;
      const others = f.machines.length + f.tools.length + f.families.length + f.models.length > 0;
      const ids = [...new Set([...machines.map((m) => departmentOf(m.id)), ...f.departments])];
      return ids
        .filter((id) => !ok || ok.has(id) || f.departments.includes(id))
        .sort((a, b) =>
          a === NO_DEPARTMENT
            ? 1
            : b === NO_DEPARTMENT
              ? -1
              : departmentName(a).localeCompare(departmentName(b)),
        )
        .map((id) => {
          const stale = ok !== undefined && !ok.has(id);
          return {
            id,
            label: departmentName(id),
            stale,
            note: notes(stale && staleNote(others)),
          };
        });
    },
    selected: () => new Set(state.filters.departments),
    onChange: (next, first) => setFilters({ departments: [...next] }, first),
  });
  const machineSelect = multiSelect({
    label: "Machines",
    allLabel: "All machines",
    emptyText: nothingLeft,
    choices: () => {
      const f = state.filters;
      const ok = offered()?.machines;
      const others =
        f.departments.length + f.tools.length + f.families.length + f.models.length > 0;
      return machines
        .filter((m) => m.removed_at === null)
        .filter((m) => !ok || ok.has(m.id) || f.machines.includes(m.id))
        .map((m) => {
          const stale = ok !== undefined && !ok.has(m.id);
          return {
            id: m.id,
            label: m.name,
            stale,
            note: notes(m.revoked_at !== null && "revoked", stale && staleNote(others)),
          };
        });
    },
    selected: () => new Set(state.filters.machines),
    onChange: (next, first) => setFilters({ machines: [...next] }, first),
  });
  const toolSelect = multiSelect({
    label: "Tools",
    allLabel: "All tools",
    emptyText: nothingLeft,
    choices: () => {
      const f = state.filters;
      const ok = offered()?.tools;
      const others =
        f.departments.length + f.machines.length + f.families.length + f.models.length > 0;
      return knownTools()
        .filter((id) => !ok || ok.has(id) || f.tools.includes(id))
        .map((id) => {
          const stale = ok !== undefined && !ok.has(id);
          return { id, label: toolName(id), stale, note: notes(stale && staleNote(others)) };
        });
    },
    selected: () => new Set(state.filters.tools),
    onChange: (next, first) => setFilters({ tools: [...next] }, first),
  });
  // Model families, each with its models: f:<family> and m:<model>.
  const modelSelect = multiSelect({
    label: "Models",
    allLabel: "All models",
    emptyText: nothingLeft,
    choices: () => {
      const f = state.filters;
      const ok = offered()?.models;
      const note = staleNote(f.departments.length + f.machines.length + f.tools.length > 0);
      // Every known model stays in its family (so ticking all of a family's
      // listed models doesn't pick models that are only hidden); the ones
      // with no matching usage are hidden.
      const families = new Map<string, Choice & { children: Choice[] }>();
      for (const m of knownModels()) {
        const fam = modelFamily(m);
        const family = families.get(fam.id) ?? {
          id: `f:${fam.id}`,
          label: fam.label,
          children: [],
        };
        const used = !ok || ok.has(m);
        const picked = f.models.includes(m);
        family.children.push({
          id: `m:${m}`,
          label: m,
          hidden: !used && !picked,
          stale: !used && picked,
          note: !used && picked ? note : undefined,
        });
        families.set(fam.id, family);
      }
      return [...families.values()].map((family) => {
        const picked = f.families.includes(family.id.slice(2));
        const anyShown = family.children.some((k) => !k.hidden);
        const anyUsed = family.children.some((k) => !k.hidden && !k.stale);
        const stale = picked && !anyUsed;
        return {
          ...family,
          hidden: !anyShown && !picked,
          stale,
          note: stale ? note : undefined,
        };
      });
    },
    selected: () =>
      new Set([
        ...state.filters.families.map((f) => `f:${f}`),
        ...state.filters.models.map((m) => `m:${m}`),
      ]),
    onChange: (next, first) => {
      const picked = (prefix: string) =>
        [...next].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length));
      setFilters({ families: picked("f:"), models: picked("m:") }, first);
    },
  });
  const selects: MultiSelect[] = [departmentSelect, machineSelect, toolSelect, modelSelect];
  const clearFilters = h(
    "button",
    {
      type: "button",
      class: "small",
      onclick: () => {
        setFilters(noFilters(), true);
        (departmentSelect.element.hidden ? machineSelect : departmentSelect).element
          .querySelector("button")
          ?.focus();
      },
    },
    "Clear filters",
  );
  limits.append(
    departmentSelect.element,
    machineSelect.element,
    toolSelect.element,
    modelSelect.element,
    clearFilters,
  );

  /** Shows the dropdowns that have something to choose from, and Clear when any filter is on. */
  function paintLimits() {
    const f = state.filters;
    // A list appears once the period has more than one of its kind, and stays
    // however far the other filters narrow it.
    const d = summary?.detail;
    departmentSelect.element.hidden = departmentsInPeriod().size < 2 && f.departments.length === 0;
    machineSelect.element.hidden =
      (d ? d.machines.length : machines.length) < 2 && f.machines.length === 0;
    toolSelect.element.hidden =
      (d ? d.sources.length : knownTools().length) < 2 && f.tools.length === 0;
    modelSelect.element.hidden =
      (d ? d.models.length : knownModels().length) < 2 &&
      f.families.length === 0 &&
      f.models.length === 0;
    clearFilters.hidden = !isFiltered(f);
    limits.hidden = selects.every((x) => x.element.hidden) && clearFilters.hidden;
    for (const x of selects) x.refresh();
  }

  tableToggle.addEventListener("click", () => {
    state.tableView = !state.tableView;
    tableToggle.textContent = state.tableView ? "Show as chart" : "Show as table";
    draw();
  });

  /** Shows which period is active: a preset's radio button, or the custom button. */
  function paintPeriod() {
    const custom = state.range === "custom";
    customButton.classList.toggle("active", custom);
    if (custom) {
      fill(
        periodText,
        h("span", { class: "visually-hidden" }, "Custom period: "),
        formatRange(state.from, state.to),
      );
      for (const radio of periodFilter.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
        radio.checked = false;
      }
    } else {
      fill(periodText, "Custom");
    }
  }

  /** Puts the page's state in its address; `push` makes a new history entry for Back. */
  function writeUrl(push: boolean) {
    const q = new URLSearchParams({ range: state.range });
    if (state.range === "custom") {
      q.set("from", state.from);
      q.set("to", state.to);
    }
    q.set("by", state.split);
    q.set("measure", state.measure);
    writeFilters(q, state.filters);
    if (push) history.pushState(null, "", `/?${q}`);
    else history.replaceState(null, "", `/?${q}`);
  }

  function update(change: Partial<typeof state>) {
    Object.assign(state, change);
    if (state.range !== "custom") {
      state.from = "";
      state.to = "";
    }
    // A new period gets its own history entry, so Back returns to the last one.
    writeUrl(change.range !== undefined);
    paintPeriod();
    if (change.range) void load();
    else draw();
  }

  /** Today in the dashboard's time zone (the browser's until the first load). */
  const today = () => summary?.today ?? new Date().toISOString().slice(0, 10);

  const removePicker = rangePicker(customButton, {
    current: () =>
      state.range === "custom"
        ? { from: state.from, to: state.to }
        : summary
          ? { from: summary.from, to: summary.to }
          : { from: addDays(today(), -29), to: today() },
    today,
    timezone: () => summary?.timezone ?? "",
    usageDays: (from, to) => {
      // The dots follow the filters too.
      const q = new URLSearchParams({ from, to });
      const allowed = allowedMachines(
        state.filters,
        machines.map((m) => m.id),
        departmentOf,
      );
      // No machine at all: ask about one that can't exist, for no days.
      for (const m of allowed?.length === 0 ? ["-"] : (allowed ?? [])) q.append("machine", m);
      for (const t of state.filters.tools) q.append("source", t);
      for (const m of allowedModels(state.filters, knownModels()) ?? []) q.append("model", m);
      return getCached<{ days: string[] }>(`/usage-days?${q}`).then((r) => r.days);
    },
    onApply: (from, to) => update({ range: "custom", from, to }),
  });
  paintPeriod();

  async function load() {
    loadedAt = Date.now();
    chartBox.classList.add("loading");
    try {
      const path =
        state.range === "custom"
          ? `/summary?from=${state.from}&to=${state.to}&detail=1`
          : state.range === "all"
            ? "/summary?all=1&detail=1"
            : `/summary?days=${Number(state.range)}&detail=1`;
      const [s, m, p] = await Promise.all([
        getCached<DetailedSummary>(path),
        api<MachinesResponse>("/machines"),
        ctx.me.role === "admin"
          ? api<{ requests: PairingRequest[] }>("/pairing").then((r) => r.requests)
          : Promise.resolve([] as PairingRequest[]),
      ]);
      summary = s;
      machines = m.machines;
      machineById = new Map(machines.map((x) => [x.id, x]));
      pending = p;
      // Departments are read again only when a machine is in one not seen yet.
      const missing = machines.some(
        (x) => x.department && !departments.some((d) => d.id === x.department?.id),
      );
      if (missing) {
        departments = (await api<{ departments: Department[] }>("/departments")).departments;
        departments.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      }
      draw();
    } finally {
      chartBox.classList.remove("loading");
    }
  }

  function draw() {
    paintLimits();
    if (!summary) return;
    const all = summary;
    const s = applyFilters(all, state.filters, departmentOf);
    const tzNote = document.querySelector("#tz-note");
    if (tzNote) {
      const period =
        s.from === s.to ? day(s.to, "long") : `${day(s.from, "long")} – ${day(s.to, "long")}`;
      tzNote.textContent = `${period} · days in ${s.timezone}`;
    }
    const multiTool = knownTools().length > 1;
    if (toolOption) toolOption.hidden = !multiTool && state.split !== "tool";
    if (departmentOption) {
      departmentOption.hidden = departmentsInPeriod().size < 2 && state.split !== "department";
    }
    toolsCard.hidden = !multiTool;
    drawBanners();
    drawTiles(s, multiTool);
    drawChart(s);
    drawBreakdown(s);
    if (multiTool) drawTools(s);
    drawModels(s);
  }

  function drawBanners() {
    const items: Child[] = [];
    if (pending.length > 0) {
      items.push(
        h(
          "div",
          { class: "banner info" },
          h("span", { class: "icon", "aria-hidden": "true" }, "●"),
          h(
            "span",
            null,
            `${pending.length} machine${pending.length === 1 ? " is" : "s are"} waiting to join. `,
            h("a", { href: "/approve" }, "Approve"),
          ),
        ),
      );
    }
    const late = machines.filter((m) => m.status === "late");
    if (late.length > 0) {
      items.push(
        h(
          "div",
          { class: "banner warning" },
          h("span", { class: "icon", "aria-hidden": "true" }, "▲"),
          h(
            "span",
            null,
            late.length === 1
              ? `${late[0]?.name} hasn't reported on schedule. `
              : `${late.length} machines haven't reported on schedule. `,
            h("a", { href: "/machines" }, "See machines"),
          ),
        ),
      );
    }
    fill(banners, items);
  }

  function drawTiles(s: Summary, multiTool: boolean) {
    const total = emptyTotals();
    for (const r of s.by_day_machine) addInto(total, r);
    const f = state.filters;
    const active = machines.filter(
      (m) =>
        m.revoked_at === null &&
        (f.machines.length === 0 || f.machines.includes(m.id)) &&
        (f.departments.length === 0 || f.departments.includes(departmentOf(m.id))),
    );
    const ok = active.filter((m) => m.status === "ok").length;
    const late = active.filter((m) => m.status === "late").length;
    const tile = (label: string, value: string, note: string) =>
      h(
        "div",
        { class: "tile" },
        h("span", { class: "tile-label" }, label),
        h("span", { class: "tile-value" }, value),
        h("span", { class: "tile-note" }, note),
      );
    tiles.replaceChildren(
      tile(
        "Tokens",
        compactNumber(totalTokens(total)),
        `${compactNumber(total.cache_read_tokens)} of them cache reads`,
      ),
      tile(
        "Output tokens",
        compactNumber(total.output_tokens),
        multiTool ? "Text the models wrote" : "Text Claude wrote",
      ),
      tile("Estimated cost", money(total.cost_usd), COST_NOTE[s.pricing?.mode ?? "ccusage"]),
      tile(
        "Machines reporting",
        `${ok} of ${active.length}`,
        active.length === 0 ? "No machines yet" : late > 0 ? `${late} late` : "All on schedule",
      ),
    );
  }

  /** Series for the current split, in color order, limited to ones with data. */
  function seriesFor(s: Summary): {
    series: Series[];
    keyOf: (row: Record<string, unknown>) => string;
  } {
    if (state.split === "machine") {
      const map = machineSeries(machines);
      const seen = new Set(s.by_day_machine.map((r) => map.get(r.machine_id)?.id ?? "other"));
      const all = [...new Map([...map.values()].map((sr) => [sr.id, sr])).values()];
      const series = all.filter((sr) => seen.has(sr.id));
      if (seen.has("other") && !series.some((sr) => sr.id === "other")) {
        series.push({ id: "other", label: "Other machines", colorClass: "s-other" });
      }
      return { series, keyOf: (r) => map.get(String(r.machine_id))?.id ?? "other" };
    }
    if (state.split === "department") {
      const seen = s.by_day_machine.map((r) => departmentOf(r.machine_id));
      const map = stableSeries(
        [...departments.map((d) => d.id), NO_DEPARTMENT],
        seen,
        departmentName,
        "Other departments",
      );
      return {
        series: seriesOf(map, seen),
        keyOf: (r) => map.get(departmentOf(String(r.machine_id)))?.id ?? "other",
      };
    }
    if (state.split === "tool") {
      const sources = s.by_day_source.map((r) => r.source);
      const map = toolSeries(s.tools, sources);
      return {
        series: seriesOf(map, sources),
        keyOf: (r) => map.get(String(r.source))?.id ?? "other",
      };
    }
    const models = s.by_day_model.map((r) => r.model);
    const map = familySeries(s.models, models);
    const familyOf = (model: string) => modelFamily(model).id;
    return {
      series: seriesOf(map, models.map(familyOf)),
      keyOf: (r) => map.get(familyOf(String(r.model)))?.id ?? "other",
    };
  }

  function drawChart(s: Summary) {
    const bucket = s.bucket ?? "day";
    const { series, keyOf } = seriesFor(s);
    const rows =
      state.split === "machine" || state.split === "department"
        ? s.by_day_machine
        : state.split === "tool"
          ? s.by_day_source
          : s.by_day_model;
    const measure = measureOf[state.measure];

    const columns: Column[] = bucketKeys(s.from, s.to, bucket).map((key) => ({
      key,
      ...bucketLabels(key, bucket),
      values: new Map(),
    }));
    const byKey = new Map(columns.map((c) => [c.key, c]));
    for (const r of rows) {
      const col = byKey.get(bucketStart(r.day, bucket));
      if (!col) continue;
      const id = keyOf(r as unknown as Record<string, unknown>);
      col.values.set(id, (col.values.get(id) ?? 0) + measure(r));
    }

    const per = bucket === "day" ? "Daily" : bucket === "week" ? "Weekly" : "Monthly";
    chartTitle.textContent = `${per} ${MEASURE_TITLE[state.measure]} by ${state.split}`;
    chartSubtitle.textContent =
      state.measure === "cost"
        ? "Estimated at API prices."
        : state.measure === "tokens"
          ? "Input, output and cache tokens."
          : "";
    const fmt = state.measure === "cost" ? money : compactNumber;
    const exact = state.measure === "cost" ? money : fullNumber;

    if (rows.length === 0) {
      legendSlot.replaceChildren();
      chartBox.replaceChildren(
        h(
          "div",
          { class: "empty" },
          machines.length === 0
            ? seesAll(ctx.me)
              ? [
                  h("strong", null, "No machines yet"),
                  h(
                    "span",
                    null,
                    "Install ccunified on a machine and approve it to see usage here.",
                  ),
                  h("a", { href: "/machines" }, "How to add a machine"),
                ]
              : [
                  h("strong", null, "No machines to show yet"),
                  h(
                    "span",
                    null,
                    "You see the machines you own and those of the departments you manage or view. Ask an admin or your manager if one is missing.",
                  ),
                ]
            : isFiltered(state.filters)
              ? [
                  h("strong", null, "Nothing matches these filters in this period"),
                  h("span", null, "Try a longer period, or other filters."),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "small",
                      onclick: () => setFilters(noFilters(), true),
                    },
                    "Clear filters",
                  ),
                ]
              : [
                  h("strong", null, "No usage in this period"),
                  h("span", null, "Try a longer period."),
                ],
        ),
      );
      return;
    }

    legendSlot.replaceChildren(legend(series) ?? "");
    if (state.tableView) {
      chartBox.replaceChildren(
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h(
                  "th",
                  { scope: "col" },
                  bucket === "day" ? "Day" : bucket === "week" ? "Week of" : "Month",
                ),
                series.map((sr) => h("th", { scope: "col", class: "num" }, sr.label)),
                h("th", { scope: "col", class: "num" }, "Total"),
              ),
            ),
            h(
              "tbody",
              null,
              [...columns].reverse().map((c) => {
                const total = series.reduce((sum, sr) => sum + (c.values.get(sr.id) ?? 0), 0);
                return h(
                  "tr",
                  { class: total === 0 ? "dim" : undefined },
                  h("th", { scope: "row" }, c.title),
                  series.map((sr) => h("td", { class: "num" }, exact(c.values.get(sr.id) ?? 0))),
                  h("td", { class: "num" }, exact(total)),
                );
              }),
            ),
          ),
        ),
      );
      return;
    }
    renderColumns(chartBox, { series, columns, formatValue: exact, formatAxis: fmt });
  }

  function breakdownTable(
    title: string,
    caption: string,
    entries: {
      label: string;
      /** A second, quieter line, such as where a model's price came from. */
      sub?: string;
      colorClass?: string;
      totals: Totals;
      dim?: boolean;
    }[],
  ): Child[] {
    const measure = measureOf[state.measure];
    const sum = emptyTotals();
    for (const e of entries) addInto(sum, e.totals);
    const sorted = [...entries].sort((a, b) => measure(b.totals) - measure(a.totals));
    return [
      h("div", { class: "card-head" }, h("div", null, h("h2", null, title), h("p", null, caption))),
      sorted.length === 0
        ? h("p", { class: "muted" }, "No usage in this period.")
        : h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              null,
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  [
                    "Name",
                    "Input",
                    "Output",
                    "Cache write",
                    "Cache read",
                    "Total tokens",
                    "Est. cost",
                    "Share",
                  ].map((t, i) => h("th", { scope: "col", class: i > 0 ? "num" : undefined }, t)),
                ),
              ),
              h(
                "tbody",
                null,
                sorted.map((e) =>
                  h(
                    "tr",
                    { class: e.dim ? "dim" : undefined },
                    h(
                      "th",
                      { scope: "row" },
                      h(
                        "span",
                        { class: "name-cell" },
                        e.colorClass ? h("span", { class: `swatch ${e.colorClass}` }) : null,
                        e.label,
                      ),
                      e.sub ? h("span", { class: "sub" }, e.sub) : null,
                    ),
                    h("td", { class: "num" }, fullNumber(e.totals.input_tokens)),
                    h("td", { class: "num" }, fullNumber(e.totals.output_tokens)),
                    h("td", { class: "num" }, fullNumber(e.totals.cache_creation_tokens)),
                    h("td", { class: "num" }, fullNumber(e.totals.cache_read_tokens)),
                    h("td", { class: "num" }, fullNumber(totalTokens(e.totals))),
                    h("td", { class: "num" }, money(e.totals.cost_usd)),
                    h("td", { class: "num" }, percent(measure(e.totals), measure(sum))),
                  ),
                ),
              ),
              sorted.length > 1
                ? h(
                    "tfoot",
                    null,
                    h(
                      "tr",
                      null,
                      h("td", null, "Total"),
                      h("td", { class: "num" }, fullNumber(sum.input_tokens)),
                      h("td", { class: "num" }, fullNumber(sum.output_tokens)),
                      h("td", { class: "num" }, fullNumber(sum.cache_creation_tokens)),
                      h("td", { class: "num" }, fullNumber(sum.cache_read_tokens)),
                      h("td", { class: "num" }, fullNumber(totalTokens(sum))),
                      h("td", { class: "num" }, money(sum.cost_usd)),
                      h("td", { class: "num" }, "100%"),
                    ),
                  )
                : null,
            ),
          ),
    ];
  }

  function drawBreakdown(s: Summary) {
    const map = machineSeries(machines);
    // Removed machines share one row.
    const rowOf = (id: string) => (machineById.get(id)?.removed_at ? REMOVED : id);
    const byMachine = new Map<string, Totals>();
    for (const r of s.by_day_machine) {
      const id = rowOf(r.machine_id);
      const t = byMachine.get(id) ?? emptyTotals();
      addInto(t, r);
      byMachine.set(id, t);
    }
    fill(
      breakdown,
      breakdownTable(
        "Machines",
        "Usage in this period, per machine.",
        [...byMachine].map(([id, totals]) => {
          const m = machineById.get(id);
          const color = state.split === "machine" ? map.get(id)?.colorClass : undefined;
          if (id === REMOVED) {
            const gray = state.split === "machine" ? "s-other" : undefined;
            return { label: "Removed machines", colorClass: gray, totals, dim: true };
          }
          return {
            label: m ? `${m.name}${m.revoked_at !== null ? " (revoked)" : ""}` : "Unknown machine",
            colorClass: color,
            totals,
            dim: m?.revoked_at !== null,
          };
        }),
      ),
    );
  }

  function drawTools(s: Summary) {
    const map = toolSeries(
      s.tools,
      s.by_day_source.map((r) => r.source),
    );
    const byTool = new Map<string, Totals>();
    for (const r of s.by_day_source) {
      const t = byTool.get(r.source) ?? emptyTotals();
      addInto(t, r);
      byTool.set(r.source, t);
    }
    fill(
      toolsCard,
      breakdownTable(
        "Tools",
        "Usage in this period, per tool.",
        [...byTool].map(([id, totals]) => {
          const sr = map.get(id);
          return {
            // Folded tools still get their own row, under their own name.
            label: sr?.id === "other" ? toolName(id) : (sr?.label ?? toolName(id)),
            colorClass: state.split === "tool" ? sr?.colorClass : undefined,
            totals,
          };
        }),
      ),
    );
  }

  function drawModels(s: Summary) {
    const families = familySeries(
      s.models,
      s.by_day_model.map((r) => r.model),
    );
    const byModel = new Map<string, Totals>();
    for (const r of s.by_day_model) {
      const t = byModel.get(r.model) ?? emptyTotals();
      addInto(t, r);
      byModel.set(r.model, t);
    }
    fill(
      models,
      breakdownTable(
        "Models",
        "Usage in this period, per model. The chart groups models by family.",
        [...byModel].map(([model, totals]) => ({
          label: model,
          // Where its cost comes from, once costs aren't simply ccusage's.
          sub:
            s.pricing && s.pricing.mode !== "ccusage"
              ? PRICE_SOURCE_LABEL[s.pricing.sources[model] ?? "ccusage"]
              : undefined,
          colorClass:
            state.split === "model" ? families.get(modelFamily(model).id)?.colorClass : undefined,
          totals,
        })),
      ),
    );
  }

  // Redraw the chart when its width changes; refresh the data while visible.
  let lastWidth = 0;
  const resize = new ResizeObserver(() => {
    if (chartBox.clientWidth !== lastWidth && summary && !state.tableView) {
      lastWidth = chartBox.clientWidth;
      drawChart(applyFilters(summary, state.filters, departmentOf));
    }
  });
  resize.observe(chartBox);
  // Refresh while the period includes today; past days don't change. Every
  // minute up to 92 days; longer periods (weeks or months on the chart) read
  // many more rows each time, so every 10 minutes, to stay well within the
  // database reads of Cloudflare's free plan.
  const timer = window.setInterval(() => {
    const live = state.range !== "custom" || !summary || state.to >= summary.today;
    const every = summary && summary.bucket !== "day" ? LONG_REFRESH_MS : REFRESH_MS;
    if (document.visibilityState === "visible" && live && Date.now() - loadedAt >= every - 5_000) {
      void load().catch(() => undefined);
    }
  }, REFRESH_MS);

  await load();
  return () => {
    window.clearInterval(timer);
    resize.disconnect();
    removePicker();
    for (const x of selects) x.destroy();
  };
}
