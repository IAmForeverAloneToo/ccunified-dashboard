/**
 * Counts attempts or failures per key (e.g. "user:alice", "ip:203.0.113.9")
 * in a fixed window, stored in D1 so every Worker instance sees the same
 * counts.
 */
export interface Limit {
  key: string;
  max: number;
  windowMs: number;
}

/** Seconds until the first exhausted limit resets, or 0 if none is exhausted. */
export async function retryAfter(
  db: D1Database,
  limits: Limit[],
  now = Date.now(),
): Promise<number> {
  if (limits.length === 0) return 0;
  const { results } = await db
    .prepare(
      "SELECT key, window_start, failures FROM login_attempts WHERE key IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(limits.map((l) => l.key)))
    .all<{ key: string; window_start: number; failures: number }>();
  let wait = 0;
  for (const row of results) {
    const limit = limits.find((l) => l.key === row.key);
    if (!limit) continue;
    const resetsAt = row.window_start + limit.windowMs;
    if (resetsAt > now && row.failures >= limit.max) {
      wait = Math.max(wait, Math.ceil((resetsAt - now) / 1000));
    }
  }
  return wait;
}

/** Adds one to a key's count (starting a new window if the last one is over); returns the count. */
export function recordFailure(db: D1Database, limit: Limit, now = Date.now()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO login_attempts (key, window_start, failures) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN window_start <= ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING window_start, failures`,
    )
    .bind(limit.key, now, now - limit.windowMs);
}

/**
 * Counts an attempt against each limit before anything is checked, and
 * returns the seconds until the limits it went over reset (0 if none).
 * Counting first means requests sent at once can't all slip under a limit:
 * each one sees the count with itself included.
 */
export async function countAttempt(
  db: D1Database,
  limits: Limit[],
  now = Date.now(),
): Promise<number> {
  if (limits.length === 0) return 0;
  const results = await db.batch<{ window_start: number; failures: number }>(
    limits.map((l) => recordFailure(db, l, now)),
  );
  let wait = 0;
  limits.forEach((limit, i) => {
    const row = results[i]?.results[0];
    if (row && row.failures > limit.max) {
      const resetsAt = row.window_start + limit.windowMs;
      wait = Math.max(wait, Math.ceil((resetsAt - now) / 1000), 1);
    }
  });
  return wait;
}

/** Takes back one counted attempt, for an attempt that turned out to be fine. */
export function forgetAttempt(db: D1Database, key: string): D1PreparedStatement {
  return db
    .prepare("UPDATE login_attempts SET failures = failures - 1 WHERE key = ?1 AND failures > 0")
    .bind(key);
}

export function clearFailures(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare("DELETE FROM login_attempts WHERE key = ?1").bind(key);
}

/** The visitor's IP address as Cloudflare reports it. */
export function clientIp(headers: { get(name: string): string | null }): string {
  return headers.get("cf-connecting-ip") ?? "unknown";
}
