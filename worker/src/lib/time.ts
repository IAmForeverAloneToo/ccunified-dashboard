const DAY_MS = 86_400_000;

/** True if `tz` is an IANA time zone name the runtime understands. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayIn(tz: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
}

/** A step of the dashboard's chart: a day, a week (from Monday) or a month. */
export type Bucket = "day" | "week" | "month";

/** The chart's step for a period of `days` days: days up to 92, weeks up to two years, then months. */
export function bucketFor(days: number): Bucket {
  if (days <= 92) return "day";
  if (days <= 731) return "week";
  return "month";
}
