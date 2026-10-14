import { SERVER_VERSION, SOURCE_REPO } from "../version";
import { compareVersions } from "./semver";

const TIMEOUT_MS = 10_000;

/** A release tag such as "v0.2.0" as a version, or null if it isn't one. */
function tagVersion(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const version = tag.replace(/^v/, "");
  return compareVersions(version, version) === undefined ? null : version;
}

/**
 * Asks GitHub for the newest release (pre-releases don't count). Returns its
 * version, or why it couldn't be found, worded to follow "Couldn't check for
 * updates: ".
 */
export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
): Promise<{ version: string } | { error: string }> {
  const userAgent = `ccunified/${SERVER_VERSION}`;
  let problem = "GitHub couldn't be reached";
  try {
    const res = await fetcher(`https://api.github.com/repos/${SOURCE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const version = tagVersion(((await res.json()) as { tag_name?: unknown }).tag_name);
      if (version) return { version };
      problem = "GitHub's answer didn't name a version";
    } else if (res.status === 404) {
      return { error: `GitHub has no releases of ${SOURCE_REPO}` };
    } else {
      problem =
        res.status === 403 || res.status === 429
          ? "GitHub is limiting requests right now"
          : `GitHub answered with an error (HTTP ${res.status})`;
    }
  } catch {
    // Unreachable or too slow; try the releases page.
  }
  // The releases page redirects to the newest release. It isn't subject to
  // the API's per-address limit, which Cloudflare's shared addresses can hit.
  try {
    const res = await fetcher(`https://github.com/${SOURCE_REPO}/releases/latest`, {
      redirect: "manual",
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1];
    const version = tag ? tagVersion(decodeURIComponent(tag)) : null;
    if (version) return { version };
  } catch {
    // Report what the API said.
  }
  return { error: problem };
}
