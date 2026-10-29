import { SERVER_VERSION } from "../version";
import { fetchLatestRelease } from "./releases";
import { compareVersions } from "./semver";
import { type Settings, setSetting } from "./settings";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * The newest released version, as last seen on GitHub. Refreshes in the
 * background at most every 6 hours; never delays the request.
 */
export function latestVersion(
  db: D1Database,
  settings: Settings,
  ctx: { waitUntil(p: Promise<unknown>): void },
  fetcher: typeof fetch = fetch,
): string | null {
  const isRelease = compareVersions(SERVER_VERSION, SERVER_VERSION) !== undefined;
  const stale =
    (settings.latestCheckedAt ?? 0) < Date.now() - CHECK_EVERY_MS ||
    settings.latestCheckError === null;
  if (isRelease && stale) ctx.waitUntil(refreshLatestVersion(db, fetcher));
  return pickLatest(settings.latestVersion, SERVER_VERSION);
}

/** Picks the newest of the given versions, ignoring anything that isn't a version. */
export function pickLatest(...versions: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!v || compareVersions(v, v) === undefined) continue;
    if (best === null || (compareVersions(v, best) ?? 0) > 0) best = v;
  }
  return best;
}

/** Checks GitHub for a new release now, and records the outcome. */
export async function refreshLatestVersion(
  db: D1Database,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const now = String(Date.now());
  const result = await fetchLatestRelease(fetcher);
  const writes = [
    setSetting(db, "latest_checked_at", now),
    setSetting(db, "latest_check_error", "error" in result ? result.error : ""),
  ];
  if ("version" in result) writes.push(setSetting(db, "latest_version", result.version));
  await db.batch(writes);
}
