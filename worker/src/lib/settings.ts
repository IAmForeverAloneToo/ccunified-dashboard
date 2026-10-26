import { type PricingMode, readPricingMode } from "./pricing";

export interface Settings {
  timezone: string;
  dataVersion: number;
  latestVersion: string | null;
  latestCheckedAt: number | null;
  /**
   * Why the last check for a new release failed: "" if it worked, null if no
   * check has recorded its outcome yet (none since ccunified 0.2).
   */
  latestCheckError: string | null;
  /** Every tool the dashboard has seen, in the order they first appeared. */
  tools: string[];
  /** Every model the dashboard has seen, in the order they first appeared. */
  models: string[];
  /** How costs are worked out (see lib/pricing.ts). */
  pricing: PricingMode;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{
    key: string;
    value: string;
  }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const checked = map.get("latest_checked_at");
  return {
    timezone: map.get("timezone") ?? "UTC",
    dataVersion: Number(map.get("data_version") ?? "0"),
    latestVersion: map.get("latest_version") ?? null,
    latestCheckedAt: checked ? Number(checked) : null,
    latestCheckError: map.get("latest_check_error") ?? null,
    tools: parseList(map.get("tools")),
    models: parseList(map.get("models")),
    pricing: readPricingMode(map.get("pricing")),
  };
}

/** Reads a JSON array of strings, ignoring anything else. */
export function parseList(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setSetting(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);
}

/** Marks usage data as changed, so dashboards holding an old copy refetch it. */
export function bumpDataVersion(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_version'",
  );
}
