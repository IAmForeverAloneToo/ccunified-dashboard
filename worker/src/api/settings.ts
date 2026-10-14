import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail, readJson } from "../lib/http";
import { getSettings, setSetting } from "../lib/settings";
import { isValidTimezone } from "../lib/time";
import { latestVersion } from "../lib/updates";
import { SERVER_VERSION } from "../version";

/** GET /api/settings */
export async function readSettings(c: Context<AppEnv>): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  return c.json({
    timezone: settings.timezone,
    server_version: SERVER_VERSION,
    latest_version: latestVersion(c.env.DB, settings, c.executionCtx),
  });
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
