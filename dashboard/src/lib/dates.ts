/**
 * Calendar dates for the date range picker. Dates are "YYYY-MM-DD" strings in
 * the dashboard's time zone, and all arithmetic happens in UTC, so neither
 * the browser's time zone nor daylight saving can shift a day.
 */
import { addDays } from "./format";

export { addDays };

/** The longest range the dashboard's API serves (about ten years). */
export const MAX_RANGE_DAYS = 3660;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const toUTC = (date: string) => new Date(`${date}T00:00:00Z`);
const fromUTC = (d: Date) => d.toISOString().slice(0, 10);

/** Whether s is a real calendar date written as YYYY-MM-DD. */
export function isDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = toUTC(s);
  return !Number.isNaN(d.getTime()) && fromUTC(d) === s;
}

/** Number of days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUTC(to).getTime() - toUTC(from).getTime()) / 86_400_000) + 1;
}

/** The first day of date's month. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first day of the month n months after month's. */
export function addMonths(month: string, n: number): string {
  const d = toUTC(monthStart(month));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fromUTC(d);
}

/** The last day of date's month. */
export function monthEnd(date: string): string {
  return addDays(addMonths(date, 1), -1);
}

/** The same day n months later, moved back to the month's end if needed (Jan 31 → Feb 28). */
export function addMonthsKeepDay(date: string, n: number): string {
  const target = addMonths(date, n);
  const day = Math.min(Number(date.slice(8)), Number(monthEnd(target).slice(8)));
  return `${target.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

/** Day of the week: 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return toUTC(date).getUTCDay();
}

/** The first day of date's week, for weeks starting on firstDay (0 = Sunday). */
export function weekStart(date: string, firstDay: number): string {
  return addDays(date, -((weekday(date) - firstDay + 7) % 7));
}

/**
 * The weeks of month's calendar page: rows of seven dates, with null for the
 * days that belong to the previous or next month.
 */
export function monthGrid(month: string, firstDay: number): (string | null)[][] {
  const first = monthStart(month);
  const last = monthEnd(month);
  const weeks: (string | null)[][] = [];
  for (let day = weekStart(first, firstDay); day <= last; day = addDays(day, 7)) {
    const week: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(day, i);
      week.push(d >= first && d <= last ? d : null);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The weekdays (0 = Sunday) in column order. */
export function weekdayOrder(firstDay: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
}

/**
 * The first day of the week where the user is (0 = Sunday), from the
 * browser's locale. Monday when the browser can't tell.
 */
export function localeFirstDay(locale = navigator.language): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
  } catch {
    // Unknown locale: use the default below.
  }
  return 1;
}

/** Returns the two dates in order. */
export function ordered(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export interface Preset {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Calendar-aligned shortcuts, ending no later than today. */
export function presets(today: string, firstDay: number): Preset[] {
  const thisWeek = weekStart(today, firstDay);
  const thisMonth = monthStart(today);
  const lastMonth = addMonths(thisMonth, -1);
  const year = Number(today.slice(0, 4));
  return [
    { id: "this-week", label: "This week", from: thisWeek, to: today },
    {
      id: "last-week",
      label: "Last week",
      from: addDays(thisWeek, -7),
      to: addDays(thisWeek, -1),
    },
    { id: "this-month", label: "This month", from: thisMonth, to: today },
    { id: "last-month", label: "Last month", from: lastMonth, to: monthEnd(lastMonth) },
    { id: "this-year", label: "This year", from: `${year}-01-01`, to: today },
    { id: "last-year", label: "Last year", from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
  ];
}

/**
 * Reads a typed date: YYYY-MM-DD, also with "/" or "." between the parts
 * and without leading zeros. Returns null if it isn't a real date.
 */
export function parseTyped(input: string): string | null {
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(input);
  if (!m) return null;
  const date = `${m[1]}-${(m[2] ?? "").padStart(2, "0")}-${(m[3] ?? "").padStart(2, "0")}`;
  return isDate(date) ? date : null;
}

const rangeFormat = () =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Sep 3 – 18, 2026", "Dec 28, 2025 – Jan 4, 2026", or one date for a single day. */
export function formatRange(from: string, to: string): string {
  const f = rangeFormat();
  return from === to ? f.format(toUTC(from)) : f.formatRange(toUTC(from), toUTC(to));
}

/** "Thursday, September 3, 2026": what screen readers hear for a day. */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(toUTC(date));
}

/** "September 2026". */
export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(toUTC(monthStart(month)));
}

/** Short and full weekday names (0 = Sunday). */
export function weekdayName(day: number, style: "short" | "long"): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(undefined, { weekday: style, timeZone: "UTC" }).format(
    toUTC(addDays("2023-01-01", day)),
  );
}
