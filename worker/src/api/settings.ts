import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { getSettings, type Settings, setSetting } from "../lib/settings";
import { isValidTimezone } from "../lib/time";
import { latestVersion, pickLatest, refreshLatestVersion } from "../lib/updates";
import { SERVER_VERSION, SOURCE_REPO } from "../version";

function settingsBody(settings: Settings, latest: string | null) {
  // A check counts once its outcome was recorded (dashboards before 0.2 didn't).
  const recorded = settings.latestCheckError !== null;
  return {
    timezone: settings.timezone,
    server_version: SERVER_VERSION,
    latest_version: latest,
    /** When the dashboard last asked GitHub for the newest release. */
    latest_checked_at: recorded ? settings.latestCheckedAt : null,
    /** Why that check failed; null if it worked. */
    latest_check_error: recorded && settings.latestCheckError ? settings.latestCheckError : null,
    source_repo: SOURCE_REPO,
  };
}

/** GET /api/settings */
export async function readSettings(c: Context<AppEnv>): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  return c.json(settingsBody(settings, latestVersion(c.env.DB, settings, c.executionCtx)));
}

/** POST /api/settings/check-updates — asks GitHub for the newest release now. */
export async function checkForUpdates(c: Context<AppEnv>): Promise<Response> {
  await refreshLatestVersion(c.env.DB);
  const settings = await getSettings(c.env.DB);
  return c.json(settingsBody(settings, pickLatest(settings.latestVersion, SERVER_VERSION)));
}

/**
 * PATCH /api/settings (admin). Changing the time zone makes every machine
 * re-upload its history in the new zone on its next sync.
 */
export async function updateSettings(c: Context<AppEnv>): Promise<Response> {
  const body = await readJson(c, z.strictObject({ timezone: z.string().min(1).max(64) }));
  if (!isValidTimezone(body.timezone)) fail(400, "invalid_timezone");
  await setSetting(c.env.DB, "timezone", body.timezone).run();
  return c.json({ ok: true });
}
