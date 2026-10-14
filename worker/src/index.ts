import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { machineAuth } from "./agent/auth";
import { ingest } from "./agent/ingest";
import { listMachines, renameMachine, revokeMachine } from "./api/machines";
import { readSettings, updateSettings } from "./api/settings";
import { summary } from "./api/summary";
import { serveAsset } from "./assets";
import { requireUser } from "./auth/session";
import type { AppEnv } from "./env";
import { sameOriginOnly, securityHeaders } from "./lib/security";
import { SERVER_VERSION } from "./version";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

app.get("/healthz", (c) => c.json({ ok: true, version: SERVER_VERSION }));

// Machines (upload keys, no browser session).
app.post("/agent/ingest", machineAuth, ingest);

// Dashboard API (browser session).
const api = new Hono<AppEnv>();
api.use("*", sameOriginOnly);
api.get("/me", requireUser(), (c) => {
  const u = c.get("user");
  return c.json({ id: u.id, username: u.username, role: u.role, totp_enabled: u.totpEnabled });
});
api.get("/summary", requireUser(), summary);
api.get("/machines", requireUser(), listMachines);
api.patch("/machines/:id", requireUser("admin"), renameMachine);
api.delete("/machines/:id", requireUser("admin"), revokeMachine);
api.get("/settings", requireUser(), readSettings);
api.patch("/settings", requireUser("admin"), updateSettings);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/agent/*", (c) => c.json({ error: "not_found" }, 404));
app.get("*", serveAsset);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
