import { type Child, clear, fill, h, s } from "./dom";

// A stacked column chart drawn as SVG, following the dataviz mark specs:
// columns at most 24px wide with a 4px rounded top (square at the baseline),
// a 2px surface-colored gap between stacked segments, hairline gridlines,
// a legend for 2+ series, and a hover/focus tooltip per column that lists
// every series. A table view of the same numbers is rendered by the caller.

export interface Series {
  id: string;
  label: string;
  /** CSS class carrying the fill color: "s1" … "s8" or "s-other". */
  colorClass: string;
}

export interface Column {
  key: string;
  /** Axis label (short). */
  label: string;
  /** Tooltip title (long). */
  title: string;
  values: Map<string, number>;
}

export interface ChartOptions {
  series: Series[];
  columns: Column[];
  formatValue: (n: number) => string;
  formatAxis: (n: number) => string;
  height?: number;
}

const PAD = { top: 12, right: 8, bottom: 26, left: 52 };
const MAX_COL = 24;
const RADIUS = 4;
const GAP = 2;

/** Rounds up to a "nice" axis maximum and returns evenly spaced ticks. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
}

/** Path for a rectangle with rounded top corners only. */
function topRounded(x: number, y: number, w: number, hgt: number, r: number): string {
  const rr = Math.min(r, w / 2, hgt);
  return [
    `M${x},${y + hgt}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + hgt}`,
    "Z",
  ].join(" ");
}

export function legend(series: Series[]): HTMLElement | null {
  if (series.length < 2) return null;
  return h(
    "div",
    { class: "legend" },
    series.map((sr) =>
      h(
        "span",
        { class: "legend-item" },
        h("span", { class: `swatch ${sr.colorClass}` }),
        sr.label,
      ),
    ),
  );
}

/** Renders (or re-renders) the chart into `container`. */
export function renderColumns(container: HTMLElement, opts: ChartOptions): void {
  clear(container);
  container.classList.add("chart");
  const width = Math.max(container.clientWidth, 280);
  const height = opts.height ?? 260;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const totals = opts.columns.map((c) =>
    opts.series.reduce((sum, sr) => sum + (c.values.get(sr.id) ?? 0), 0),
  );
  const ticks = niceTicks(Math.max(0, ...totals));
  const yMax = ticks.at(-1) ?? 1;
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

  const n = Math.max(opts.columns.length, 1);
  const band = plotW / n;
  const colW = Math.max(2, Math.min(MAX_COL, band * 0.62));

  const svg = s("svg", {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: "img",
    "aria-label": "Stacked column chart. Use the table view for exact values.",
  });

  // Gridlines and y-axis labels.
  const grid = s("g", { class: "grid" });
  for (const t of ticks) {
    grid.append(s("line", { x1: PAD.left, x2: width - PAD.right, y1: y(t), y2: y(t) }));
    svg.append(
      s("text", { x: PAD.left - 8, y: y(t) + 4, "text-anchor": "end" }, opts.formatAxis(t)),
    );
  }
  svg.append(grid);

  // X-axis labels: as many as fit without overlapping.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
  opts.columns.forEach((c, i) => {
    if (i % labelEvery !== 0) return;
    svg.append(
      s(
        "text",
        { x: PAD.left + band * i + band / 2, y: height - 6, "text-anchor": "middle" },
        c.label,
      ),
    );
  });

  const tooltip = h("div", { class: "tooltip", hidden: true, role: "tooltip" });
  const tooltipId = `tt-${Math.random().toString(36).slice(2)}`;
  tooltip.id = tooltipId;

  opts.columns.forEach((c, i) => {
    const cx = PAD.left + band * i + band / 2;
    const g = s("g", {
      class: "col",
      tabindex: 0,
      "aria-describedby": tooltipId,
      "aria-label": `${c.title}: ${opts.formatValue(totals[i] ?? 0)}`,
    });
    // Hit area: the whole band, taller than the marks.
    g.append(
      s("rect", { class: "hit", x: PAD.left + band * i, y: PAD.top, width: band, height: plotH }),
    );

    let acc = 0;
    const visible = opts.series.filter((sr) => (c.values.get(sr.id) ?? 0) > 0);
    visible.forEach((sr, k) => {
      const v = c.values.get(sr.id) ?? 0;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      // Gap between stacked segments: shave GAP px off the top of every
      // segment except the topmost.
      const isTop = k === visible.length - 1;
      const top = isTop ? y1 : y1 + GAP / 2;
      const bottom = k === 0 ? y0 : y0 - GAP / 2;
      const segH = bottom - top;
      if (segH <= 0.5) return;
      const x = cx - colW / 2;
      g.append(
        isTop
          ? s("path", { class: sr.colorClass, d: topRounded(x, top, colW, segH, RADIUS) })
          : s("rect", { class: sr.colorClass, x, y: top, width: colW, height: segH }),
      );
    });

    const show = () =>
      showTooltip(container, tooltip, c, i, opts, totals[i] ?? 0, cx, y(totals[i] ?? 0));
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
    g.addEventListener("blur", () => {
      tooltip.hidden = true;
    });
    svg.append(g);
  });

  svg.append(
    s("line", { class: "baseline", x1: PAD.left, x2: width - PAD.right, y1: y(0), y2: y(0) }),
  );
  container.append(svg, tooltip);
}

function showTooltip(
  container: HTMLElement,
  tooltip: HTMLElement,
  column: Column,
  _index: number,
  opts: ChartOptions,
  total: number,
  x: number,
  yTop: number,
): void {
  const rows: Child[] = opts.series
    .filter((sr) => (column.values.get(sr.id) ?? 0) > 0)
    .reverse()
    .map((sr) =>
      h(
        "div",
        { class: "tooltip-row" },
        h("span", { class: `key ${sr.colorClass}` }),
        h("span", { class: "label" }, sr.label),
        h("span", { class: "value" }, opts.formatValue(column.values.get(sr.id) ?? 0)),
      ),
    );
  fill(
    tooltip,
    h("div", { class: "tooltip-title" }, column.title),
    rows.length > 0 ? rows : h("div", { class: "muted" }, "No usage"),
    rows.length > 1
      ? h(
          "div",
          { class: "tooltip-total" },
          h("span", null, "Total"),
          h("span", null, opts.formatValue(total)),
        )
      : null,
  );
  tooltip.hidden = false;
  const width = container.clientWidth;
  const tw = tooltip.offsetWidth;
  const left = Math.min(Math.max(0, x - tw / 2), Math.max(0, width - tw));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(0, yTop - tooltip.offsetHeight - 10)}px`;
}
