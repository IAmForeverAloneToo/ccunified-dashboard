export interface Settings {
  timezone: string;
  dataVersion: number;
  latestVersion: string | null;
  latestCheckedAt: number | null;
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
  };
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
