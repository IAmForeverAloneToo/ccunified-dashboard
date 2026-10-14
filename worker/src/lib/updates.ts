import { SERVER_VERSION, SOURCE_REPO } from "../version";
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
  const stale = (settings.latestCheckedAt ?? 0) < Date.now() - CHECK_EVERY_MS;
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

export async function refreshLatestVersion(
  db: D1Database,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const now = String(Date.now());
  let found: string | null = null;
  try {
    const res = await fetcher(`https://api.github.com/repos/${SOURCE_REPO}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `ccunified/${SERVER_VERSION}`,
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown };
      if (typeof body.tag_name === "string") {
        const tag = body.tag_name.replace(/^v/, "");
        if (compareVersions(tag, tag) !== undefined) found = tag;
      }
    }
  } catch {
    // Offline or rate-limited: try again after the next interval.
  }
  const writes = [setSetting(db, "latest_checked_at", now)];
  if (found) writes.push(setSetting(db, "latest_version", found));
  await db.batch(writes);
}

/**
 * A machine running a newer release than the dashboard knows of proves that
 * release exists. Remembering it keeps the pages right without waiting up to
 * six hours for the next GitHub check, which stays the authority: it
 * overwrites this value. Only plain releases count, because pre-releases and
 * development builds are never offered as updates.
 */
export function learnLatestVersion(
  db: D1Database,
  settings: Settings,
  reported: string,
): D1PreparedStatement | undefined {
  if (!/^\d+\.\d+\.\d+$/.test(reported)) return undefined;
  const known = pickLatest(settings.latestVersion, SERVER_VERSION);
  if (known !== null && (compareVersions(reported, known) ?? 0) <= 0) return undefined;
  return setSetting(db, "latest_version", reported);
}
