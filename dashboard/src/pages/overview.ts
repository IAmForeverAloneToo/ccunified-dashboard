import {
  api,
  getCached,
  type Machine,
  type MachinesResponse,
  type PairingRequest,
  type Summary,
  type Totals,
} from "../lib/api";
import { type Column, legend, renderColumns, type Series } from "../lib/chart";
import { rangePicker } from "../lib/daterange";
import { daysInclusive, formatRange, isDate, MAX_RANGE_DAYS } from "../lib/dates";
import { type Child, fill, h, s, segmented } from "../lib/dom";
import { addDays, compactNumber, day, fullNumber, money, percent } from "../lib/format";
import { toolName, toolSeries } from "../lib/tools";
import type { PageContext } from "../main";

type RangeKey = "1" | "7" | "30" | "90" | "365" | "all";
/** A preset, or "custom" for dates picked in the calendar. */
type Period = RangeKey | "custom";
type SplitKey = "machine" | "model" | "tool";
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

/** The longest range the API serves (about ten years). */
const ALL_DAYS = 3660;

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
 * Model families get fixed chart colors; versions of a family share one.
 * Names are matched in this order, so "anthropic/claude-opus-5-5" is Opus.
 */
const FAMILIES: [id: string, label: string, match: RegExp][] = [
  ["opus", "Opus", /opus/],
  ["sonnet", "Sonnet", /sonnet/],
  ["haiku", "Haiku", /haiku/],
  ["fable", "Fable", /fable/],
  ["gpt", "GPT", /gpt|codex|(^|\/)o\d/],
  ["gemini", "Gemini", /gemini/],
  ["grok", "Grok", /grok/],
];

type Family = { id: string; label: string; colorClass: string };

const familySeries: Family[] = FAMILIES.map(([id, label], i) => ({
  id,
  label,
  colorClass: `s${i + 1}`,
}));
const otherModels: Family = { id: "other", label: "Other models", colorClass: "s-other" };

export function modelFamily(model: string): Family {
  const lower = model.toLowerCase();
  const index = FAMILIES.findIndex(([, , match]) => match.test(lower));
  return familySeries[index] ?? otherModels;
}

/**
 * Machines keep the color of their position in the order they joined
 * (oldest first), so filtering never repaints anyone. Past eight machines, the
 * newest fold into a gray "Other machines".
 */
export function machineSeries(machines: Machine[]): Map<string, Series> {
  const ordered = [...machines].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  const fold = ordered.length > 8;
  const map = new Map<string, Series>();
  ordered.forEach((m, i) => {
    if (fold && i >= 7) {
      map.set(m.id, { id: "other", label: "Other machines", colorClass: "s-other" });
    } else {
      map.set(m.id, { id: m.id, label: m.name, colorClass: `s${i + 1}` });
    }
  });
  return map;
}

/** "All" starts at the first day with usage, not at the API's ten-year limit. */
function fromFirstUsage(s: Summary): Summary {
  let first = s.to;
  for (const r of s.by_day_machine) if (r.day < first) first = r.day;
  return { ...s, from: first };
}

// ---------- Time buckets ----------

type Bucket = "day" | "week" | "month";

function bucketFor(days: number): Bucket {
  if (days <= 92) return "day";
  if (days <= 731) return "week";
  return "month";
}

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
  const filters = h(
    "div",
    { class: "filters", role: "group", "aria-label": "Filters" },
    periodFilter,
    splitFilter,
    segmented("measure", "Show", MEASURES, state.measure, (v) => update({ measure: v })),
  );

  ctx.main.append(
    h(
      "div",
      { class: "page-head" },
      h("div", null, h("h1", null, "Overview"), h("p", { id: "tz-note" }, "")),
    ),
    filters,
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

  let summary: Summary | undefined;
  let machines: Machine[] = [];
  let pending: PairingRequest[] = [];

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

  function update(change: Partial<typeof state>) {
    Object.assign(state, change);
    if (state.range !== "custom") {
      state.from = "";
      state.to = "";
    }
    const q = new URLSearchParams({ range: state.range });
    if (state.range === "custom") {
      q.set("from", state.from);
      q.set("to", state.to);
    }
    q.set("by", state.split);
    q.set("measure", state.measure);
    // A new period gets its own history entry, so Back returns to the last one.
    if (change.range) history.pushState(null, "", `/?${q}`);
    else history.replaceState(null, "", `/?${q}`);
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
    usageDays: (from, to) =>
      getCached<{ days: string[] }>(`/usage-days?from=${from}&to=${to}`).then((r) => r.days),
    onApply: (from, to) => update({ range: "custom", from, to }),
  });
  paintPeriod();

  async function load() {
    chartBox.classList.add("loading");
    try {
      const path =
        state.range === "custom"
          ? `/summary?from=${state.from}&to=${state.to}`
          : `/summary?days=${state.range === "all" ? ALL_DAYS : Number(state.range)}`;
      const [s, m, p] = await Promise.all([
        getCached<Summary>(path),
        api<MachinesResponse>("/machines"),
        ctx.me.role === "admin"
          ? api<{ requests: PairingRequest[] }>("/pairing").then((r) => r.requests)
          : Promise.resolve([] as PairingRequest[]),
      ]);
      summary = state.range === "all" ? fromFirstUsage(s) : s;
      machines = m.machines;
      pending = p;
      draw();
    } finally {
      chartBox.classList.remove("loading");
    }
  }

  function draw() {
    if (!summary) return;
    const s = summary;
    const tzNote = document.querySelector("#tz-note");
    if (tzNote) {
      const period =
        s.from === s.to ? day(s.to, "long") : `${day(s.from, "long")} – ${day(s.to, "long")}`;
      tzNote.textContent = `${period} · days in ${s.timezone}`;
    }
    const multiTool = s.tools.length > 1 || new Set(s.by_day_source.map((r) => r.source)).size > 1;
    if (toolOption) toolOption.hidden = !multiTool && state.split !== "tool";
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
    const active = machines.filter((m) => m.revoked_at === null);
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
      tile("Estimated cost", money(total.cost_usd), "At API prices, not your subscription bill"),
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
    if (state.split === "tool") {
      const map = toolSeries(
        s.tools,
        s.by_day_source.map((r) => r.source),
      );
      const seen = new Set(s.by_day_source.map((r) => map.get(r.source)?.id ?? "other"));
      const all = [...new Map([...map.values()].map((sr) => [sr.id, sr])).values()];
      return {
        series: all.filter((sr) => seen.has(sr.id)),
        keyOf: (r) => map.get(String(r.source))?.id ?? "other",
      };
    }
    const seen = new Set(s.by_day_model.map((r) => modelFamily(r.model).id));
    const series = [...familySeries, otherModels].filter((f) => seen.has(f.id));
    return { series, keyOf: (r) => modelFamily(String(r.model)).id };
  }

  function drawChart(s: Summary) {
    const days = Math.round((Date.parse(s.to) - Date.parse(s.from)) / 86_400_000) + 1;
    const bucket = bucketFor(days);
    const { series, keyOf } = seriesFor(s);
    const rows =
      state.split === "machine"
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
            ? [
                h("strong", null, "No machines yet"),
                h("span", null, "Install ccunified on a machine and approve it to see usage here."),
                h("a", { href: "/machines" }, "How to add a machine"),
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
    entries: { label: string; colorClass?: string; totals: Totals; dim?: boolean }[],
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
    const byMachine = new Map<string, Totals>();
    for (const r of s.by_day_machine) {
      const t = byMachine.get(r.machine_id) ?? emptyTotals();
      addInto(t, r);
      byMachine.set(r.machine_id, t);
    }
    const names = new Map(machines.map((m) => [m.id, m]));
    fill(
      breakdown,
      breakdownTable(
        "Machines",
        "Usage in this period, per machine.",
        [...byMachine].map(([id, totals]) => {
          const m = names.get(id);
          const color = map.get(id)?.colorClass;
          return {
            label: m ? `${m.name}${m.revoked_at !== null ? " (revoked)" : ""}` : "Unknown machine",
            colorClass: state.split === "machine" ? color : undefined,
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
          colorClass: state.split === "model" ? modelFamily(model).colorClass : undefined,
          totals,
        })),
      ),
    );
  }

  // Redraw the chart when its width changes; refresh data every minute while visible.
  let lastWidth = 0;
  const resize = new ResizeObserver(() => {
    if (chartBox.clientWidth !== lastWidth && summary && !state.tableView) {
      lastWidth = chartBox.clientWidth;
      if (summary) drawChart(summary);
    }
  });
  resize.observe(chartBox);
  // Refresh while the period includes today; past days don't change.
  const timer = window.setInterval(() => {
    const live = state.range !== "custom" || !summary || state.to >= summary.today;
    if (document.visibilityState === "visible" && live) void load().catch(() => undefined);
  }, 60_000);

  await load();
  return () => {
    window.clearInterval(timer);
    resize.disconnect();
    removePicker();
  };
}
