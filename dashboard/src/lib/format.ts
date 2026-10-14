const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const usdCompact = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 1,284 → "1.3K", 12,900,000 → "12.9M". */
export function compactNumber(n: number): string {
  return Math.abs(n) < 1000 ? whole.format(n) : compact.format(n);
}

export function fullNumber(n: number): string {
  return whole.format(n);
}

export function money(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return "< $0.01";
  return Math.abs(n) >= 10_000 ? usdCompact.format(n) : usd.format(n);
}

export function percent(part: number, total: number): string {
  if (total <= 0) return "–";
  const p = (part / total) * 100;
  return p > 0 && p < 0.1 ? "< 0.1%" : `${p.toFixed(1)}%`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", "yesterday", … */
export function relativeTime(ms: number | null, now = Date.now()): string {
  if (ms === null) return "never";
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  return new Date(ms).toLocaleDateString();
}

export function dateTime(ms: number | null): string {
  return ms === null ? "–" : new Date(ms).toLocaleString();
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Formats a YYYY-MM-DD calendar date (already in the dashboard's time zone). */
export function day(date: string, style: "short" | "long" | "month" = "short"): string {
  const d = new Date(`${date}T00:00:00Z`);
  return (style === "long" ? longDate : style === "month" ? monthYear : shortDate).format(d);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  darwin: "macOS",
};
