// A date range picker in the style of booking sites: a dropdown with one or
// two months of calendar, shortcuts, typed From/To fields, and Apply/Cancel.
// Built on the browser's popover feature (top layer, click-outside and
// Escape to close). Keyboard and screen-reader use follows the ARIA date
// picker pattern.
import {
  addDays,
  addMonths,
  addMonthsKeepDay,
  daysInclusive,
  formatRange,
  localeFirstDay,
  longDate,
  MAX_RANGE_DAYS,
  monthEnd,
  monthGrid,
  monthStart,
  monthTitle,
  ordered,
  parseTyped,
  presets,
  weekdayName,
  weekdayOrder,
  weekStart,
} from "./dates";
import { h, s } from "./dom";
import { fullNumber } from "./format";

export interface RangePickerOptions {
  /** The range to show when the picker opens. */
  current(): { from: string; to: string };
  /** The dashboard's today: later days can't be picked. */
  today(): string;
  /** The dashboard's time zone, shown under the calendar. */
  timezone(): string;
  /** The days between from and to (both included) that have usage. */
  usageDays(from: string, to: string): Promise<string[]>;
  onApply(from: string, to: string): void;
}

/** Screens this narrow get the picker as a full-width panel at the bottom. */
const SHEET = window.matchMedia("(max-width: 640px)");
/** Screens this narrow show one month instead of two. */
const ONE_MONTH = window.matchMedia("(max-width: 779px)");

let pickers = 0;

const chevron = (direction: "left" | "right") =>
  s(
    "svg",
    { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true" },
    s("path", {
      d: direction === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );

/**
 * Attaches a range picker to trigger, which opens and closes it. Returns a
 * function that removes the picker.
 */
export function rangePicker(trigger: HTMLButtonElement, opts: RangePickerOptions): () => void {
  const id = `drp-${++pickers}`;
  const firstDay = localeFirstDay();

  // Selection state while the picker is open.
  let start: string | null = null;
  let end: string | null = null;
  let hover: string | null = null;
  let focusDate = "";
  let view = ""; // the first month shown
  let error = "";
  const usage = new Map<string, Set<string>>(); // month → days with usage
  const loading = new Set<string>();

  const field = (name: "from" | "to", label: string) => {
    const input = h("input", {
      id: `${id}-${name}`,
      name,
      inputmode: "numeric",
      autocomplete: "off",
      spellcheck: false,
      placeholder: "YYYY-MM-DD",
      "aria-describedby": `${id}-format`,
    });
    return {
      input,
      label: h("label", { class: "drp-field" }, h("span", null, label), input),
    };
  };
  const from = field("from", "From");
  const to = field("to", "To");
  const presetBox = h("div", { class: "drp-presets", role: "group", "aria-label": "Shortcuts" });
  const monthsBox = h("div", { class: "drp-months" });
  const status = h("p", { class: "drp-status", id: `${id}-status` });
  const tzNote = h("p", { class: "drp-tz" });
  const live = h("div", { class: "visually-hidden", "aria-live": "polite" });
  const cancel = h("button", { type: "button" }, "Cancel");
  const apply = h("button", { type: "button", class: "primary" }, "Apply");
  const prev = h(
    "button",
    { type: "button", class: "drp-nav", "aria-label": "Previous month" },
    chevron("left"),
  );
  const next = h(
    "button",
    { type: "button", class: "drp-nav", "aria-label": "Next month" },
    chevron("right"),
  );

  const panel = h(
    "div",
    {
      class: "drp",
      id,
      popover: "auto",
      role: "dialog",
      "aria-label": "Choose dates",
      "aria-describedby": `${id}-status`,
    },
    h(
      "div",
      { class: "drp-fields" },
      from.label,
      h("span", { class: "drp-dash", "aria-hidden": "true" }, "–"),
      to.label,
      h(
        "span",
        { class: "visually-hidden", id: `${id}-format` },
        "Year, month and day, like 2026-09-03",
      ),
    ),
    h("div", { class: "drp-body" }, presetBox, monthsBox),
    h(
      "div",
      { class: "drp-footer" },
      h("div", null, status, tzNote),
      h("div", { class: "drp-actions" }, cancel, apply),
    ),
    live,
  );
  document.body.append(panel);
  trigger.popoverTargetElement = panel;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");

  const monthsShown = () => (ONE_MONTH.matches ? 1 : 2);
  const lastMonth = () => addMonths(view, monthsShown() - 1);
  const announce = (text: string) => {
    live.textContent = text;
  };

  /** The range to highlight: the selection, or the selection so far plus the day under the pointer. */
  function highlighted(): { a: string; b: string; preview: boolean } | null {
    if (start && end) return { a: start, b: end, preview: false };
    if (start && hover) {
      const [a, b] = ordered(start, hover);
      return { a, b, preview: true };
    }
    if (start) return { a: start, b: start, preview: false };
    return null;
  }

  /** Makes date visible, moving the months shown as little as needed. */
  function reveal(date: string) {
    const m = monthStart(date);
    if (m < view) view = m;
    else if (m > lastMonth()) view = addMonths(m, -(monthsShown() - 1));
  }

  // ---------- Building the calendar ----------

  function render() {
    const today = opts.today();
    const months = monthsShown();
    const order = weekdayOrder(firstDay);
    prev.disabled = false;
    next.disabled = addMonths(view, months) > monthStart(today);
    const grids = Array.from({ length: months }, (_, i) => {
      const month = addMonths(view, i);
      const titleId = `${id}-m${i}`;
      return h(
        "div",
        { class: "drp-month" },
        h(
          "div",
          { class: "drp-month-head" },
          i === 0 ? prev : h("span", { class: "drp-nav-space" }),
          h("h3", { id: titleId, class: "drp-month-title" }, monthTitle(month)),
          i === months - 1 ? next : h("span", { class: "drp-nav-space" }),
        ),
        h(
          "table",
          { class: "drp-grid", role: "grid", "aria-labelledby": titleId },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              order.map((d) =>
                h("th", { scope: "col", abbr: weekdayName(d, "long") }, weekdayName(d, "short")),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            monthGrid(month, firstDay).map((week) =>
              h(
                "tr",
                null,
                week.map((date) =>
                  date
                    ? h(
                        "td",
                        { role: "gridcell" },
                        h(
                          "button",
                          { type: "button", class: "drp-day", "data-date": date },
                          String(Number(date.slice(8))),
                          h("span", { class: "drp-dot", "aria-hidden": "true" }),
                        ),
                      )
                    : h("td", { role: "gridcell", class: "drp-empty" }),
                ),
              ),
            ),
          ),
        ),
      );
    });
    monthsBox.replaceChildren(...grids);
    paint();
    loadUsage();
  }

  /** Updates the days' looks and labels for the current state, without rebuilding them. */
  function paint() {
    const today = opts.today();
    const range = highlighted();
    for (const button of monthsBox.querySelectorAll<HTMLButtonElement>(".drp-day")) {
      const date = button.dataset.date ?? "";
      const cell = button.parentElement as HTMLElement;
      const inRange = range !== null && date >= range.a && date <= range.b;
      const isStart = range !== null && date === range.a;
      const isEnd = range !== null && date === range.b;
      const hasUsage = usage.get(monthStart(date))?.has(date) ?? false;
      const future = date > today;
      cell.classList.toggle("in-range", inRange && range?.a !== range?.b);
      cell.classList.toggle("is-preview", inRange && range?.preview === true);
      cell.classList.toggle("is-start", isStart);
      cell.classList.toggle("is-end", isEnd);
      cell.setAttribute("aria-selected", String(inRange && !range?.preview));
      button.classList.toggle("is-today", date === today);
      button.classList.toggle("has-usage", hasUsage);
      button.tabIndex = date === focusDate ? 0 : -1;
      if (date === today) button.setAttribute("aria-current", "date");
      else button.removeAttribute("aria-current");
      if (future) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
      const notes = [
        isStart && !range?.preview ? "start date" : null,
        isEnd && !range?.preview && range?.a !== range?.b ? "end date" : null,
        hasUsage ? "has usage" : null,
        future ? "not available yet" : null,
      ].filter(Boolean);
      button.setAttribute("aria-label", [longDate(date), ...notes].join(", "));
    }
    // Keep one day reachable with Tab, even if the focused day isn't shown.
    if (!monthsBox.querySelector('.drp-day[tabindex="0"]')) {
      const fallback =
        monthsBox.querySelector<HTMLButtonElement>(`.drp-day[data-date="${today}"]`) ??
        monthsBox.querySelector<HTMLButtonElement>(".drp-day");
      if (fallback) {
        fallback.tabIndex = 0;
        focusDate = fallback.dataset.date ?? focusDate;
      }
    }
    for (const button of presetBox.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.from === start && button.dataset.to === end),
      );
    }
    paintFooter();
  }

  function paintFooter() {
    status.classList.toggle("error", error !== "");
    if (error) status.textContent = error;
    else if (start && end) {
      const n = daysInclusive(start, end);
      status.textContent = `${formatRange(start, end)} · ${fullNumber(n)} day${n === 1 ? "" : "s"}`;
    } else if (start) status.textContent = `${formatRange(start, start)} · choose the end date`;
    else status.textContent = "Choose the start date";
    tzNote.textContent = `Days in ${opts.timezone()}`;
    apply.disabled = start === null;
  }

  function syncFields() {
    from.input.value = start ?? "";
    to.input.value = end ?? "";
    from.input.removeAttribute("aria-invalid");
    to.input.removeAttribute("aria-invalid");
  }

  /** Fetches which shown days have usage, for the dots. */
  function loadUsage() {
    const missing: string[] = [];
    for (let m = view; m <= lastMonth(); m = addMonths(m, 1)) {
      if (!usage.has(m) && !loading.has(m)) missing.push(m);
    }
    const first = missing[0];
    const last = missing.at(-1);
    if (!first || !last) return;
    for (const m of missing) loading.add(m);
    opts
      .usageDays(first, monthEnd(last))
      .then((days) => {
        for (const m of missing) {
          usage.set(m, new Set(days.filter((d) => monthStart(d) === m)));
        }
        if (panel.matches(":popover-open")) paint();
      })
      .catch(() => undefined)
      .finally(() => {
        for (const m of missing) loading.delete(m);
      });
  }

  function focusDay() {
    monthsBox.querySelector<HTMLButtonElement>(`.drp-day[data-date="${focusDate}"]`)?.focus();
  }

  // ---------- Choosing ----------

  function select(date: string) {
    if (date > opts.today()) return;
    error = "";
    focusDate = date;
    if (!start || end) {
      start = date;
      end = null;
      hover = null;
      announce(`Start date ${longDate(date)}. Now choose the end date.`);
    } else {
      const [a, b] = ordered(start, date);
      if (daysInclusive(a, b) > MAX_RANGE_DAYS) {
        error = `A range can cover at most ${fullNumber(MAX_RANGE_DAYS)} days.`;
        announce(error);
      } else {
        start = a;
        end = b;
        hover = null;
        announce(
          `${formatRange(a, b)} chosen, ${daysInclusive(a, b)} days. Press Apply to show it.`,
        );
      }
    }
    syncFields();
    paint();
  }

  function moveFocus(date: string) {
    const today = opts.today();
    focusDate = date > today ? today : date;
    const before = view;
    reveal(focusDate);
    if (start && !end) hover = focusDate;
    if (view !== before) render();
    else paint();
    focusDay();
  }

  /** Takes the typed dates; returns whether they make a complete range. */
  function readFields(): boolean {
    const today = opts.today();
    const a = parseTyped(from.input.value);
    const b = parseTyped(to.input.value);
    const bad = (input: HTMLInputElement, date: string | null) =>
      input.value.trim() !== "" && (date === null || date > today);
    from.input.setAttribute("aria-invalid", String(bad(from.input, a)));
    to.input.setAttribute("aria-invalid", String(bad(to.input, b)));
    if (bad(from.input, a) || bad(to.input, b)) {
      error = "Enter dates like 2026-09-03, no later than today.";
      paintFooter();
      return false;
    }
    if (!a) return false;
    const [x, y] = b ? ordered(a, b) : [a, a];
    if (daysInclusive(x, y) > MAX_RANGE_DAYS) {
      error = `A range can cover at most ${fullNumber(MAX_RANGE_DAYS)} days.`;
      paintFooter();
      return false;
    }
    error = "";
    start = x;
    end = b ? y : null;
    hover = null;
    focusDate = y;
    const before = view;
    reveal(y);
    if (view !== before) render();
    else paint();
    return end !== null;
  }

  function applyAndClose() {
    if (!start) return;
    const [a, b] = [start, end ?? start];
    panel.hidePopover();
    opts.onApply(a, b);
  }

  // ---------- Events ----------

  monthsBox.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>(".drp-day");
    if (button?.dataset.date) select(button.dataset.date);
  });
  monthsBox.addEventListener("pointerover", (e) => {
    const date = (e.target as Element).closest<HTMLButtonElement>(".drp-day")?.dataset.date;
    if (date && start && !end && date <= opts.today() && date !== hover) {
      hover = date;
      paint();
    }
  });
  monthsBox.addEventListener("pointerleave", () => {
    if (hover) {
      hover = null;
      paint();
    }
  });
  monthsBox.addEventListener("keydown", (e) => {
    const date = (e.target as Element).closest<HTMLButtonElement>(".drp-day")?.dataset.date;
    if (!date) return;
    const week = weekStart(date, firstDay);
    const target: Record<string, string | undefined> = {
      ArrowLeft: addDays(date, -1),
      ArrowRight: addDays(date, 1),
      ArrowUp: addDays(date, -7),
      ArrowDown: addDays(date, 7),
      PageUp: addMonthsKeepDay(date, e.shiftKey ? -12 : -1),
      PageDown: addMonthsKeepDay(date, e.shiftKey ? 12 : 1),
      Home: week,
      End: addDays(week, 6),
    };
    const dest = target[e.key];
    if (!dest) return;
    e.preventDefault();
    moveFocus(dest);
  });
  prev.addEventListener("click", () => {
    view = addMonths(view, -1);
    render();
  });
  next.addEventListener("click", () => {
    view = addMonths(view, 1);
    render();
  });
  for (const input of [from.input, to.input]) {
    input.addEventListener("change", () => readFields());
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (readFields()) applyAndClose();
    });
  }
  presetBox.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!button?.dataset.from || !button.dataset.to) return;
    error = "";
    start = button.dataset.from;
    end = button.dataset.to;
    hover = null;
    focusDate = end;
    view = addMonths(monthStart(end), -(monthsShown() - 1));
    syncFields();
    render();
    announce(`${button.textContent}: ${formatRange(start, end)}. Press Apply to show it.`);
  });
  cancel.addEventListener("click", () => panel.hidePopover());
  apply.addEventListener("click", applyAndClose);

  function position() {
    if (SHEET.matches) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      return;
    }
    const r = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8));
    let top = r.bottom + 6;
    if (top + panel.offsetHeight > window.innerHeight - 8 && r.top - panel.offsetHeight - 6 >= 8) {
      top = r.top - panel.offsetHeight - 6;
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  const relayout = () => {
    if (!panel.matches(":popover-open")) return;
    reveal(focusDate);
    render();
    position();
  };

  panel.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    // Place it under the button before it first appears; refined once shown.
    if (!SHEET.matches) {
      const r = trigger.getBoundingClientRect();
      panel.style.left = `${Math.max(8, r.left)}px`;
      panel.style.top = `${r.bottom + 6}px`;
    }
    const today = opts.today();
    const current = opts.current();
    start = current.from;
    end = current.to;
    hover = null;
    error = "";
    focusDate = end;
    view = addMonths(monthStart(end), -(monthsShown() - 1));
    presetBox.replaceChildren(
      ...presets(today, firstDay).map((p) =>
        h("button", { type: "button", "data-from": p.from, "data-to": p.to }, p.label),
      ),
    );
    syncFields();
    render();
    live.textContent = "";
  });
  panel.addEventListener("toggle", (e) => {
    const open = (e as ToggleEvent).newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      position();
      focusDay();
      requestAnimationFrame(position);
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
    } else {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (!document.activeElement || document.activeElement === document.body) trigger.focus();
    }
  });
  ONE_MONTH.addEventListener("change", relayout);
  SHEET.addEventListener("change", relayout);

  return () => {
    ONE_MONTH.removeEventListener("change", relayout);
    SHEET.removeEventListener("change", relayout);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    if (panel.matches(":popover-open")) panel.hidePopover();
    panel.remove();
  };
}
