import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { machineAuth } from "./agent/auth";
import { ingest } from "./agent/ingest";
import { pollPairing, startPairing } from "./agent/pair";
import { listMachines, renameMachine, revokeMachine } from "./api/machines";
import { approvePairing, denyPairing, listPairing } from "./api/pairing";
import { readSettings, updateSettings } from "./api/settings";
import { summary } from "./api/summary";
import { createUser, deleteUser, listUsers, updateUser } from "./api/users";
import { serveAsset } from "./assets";
import {
  changePassword,
  disableTotp,
  enableTotp,
  login,
  loginParams,
  logout,
  regenerateRecoveryCodes,
  startTotpSetup,
} from "./auth/routes";
import { requireUser } from "./auth/session";
import type { AppEnv } from "./env";
import { sameOriginOnly, securityHeaders } from "./lib/security";
import { SERVER_VERSION } from "./version";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

app.get("/healthz", (c) => c.json({ ok: true, version: SERVER_VERSION }));

// Machines: pairing (no key yet) and uploads (upload key).
app.post("/agent/pair/start", startPairing);
app.post("/agent/pair/poll", pollPairing);
app.post("/agent/ingest", machineAuth, ingest);

// Dashboard API (browser session).
const api = new Hono<AppEnv>();
api.use("*", sameOriginOnly);

api.get("/login-params", loginParams);
api.post("/login", login);
api.post("/logout", logout);

const pendingOk = { beforePasswordChange: true };
api.get("/me", requireUser("viewer", pendingOk), (c) => {
  const u = c.get("user");
  return c.json({
    id: u.id,
    username: u.username,
    role: u.role,
    totp_enabled: u.totpEnabled,
    must_change_password: u.mustChangePassword,
  });
});
api.post("/me/password", requireUser("viewer", pendingOk), changePassword);
api.post("/me/2fa/setup", requireUser(), startTotpSetup);
api.post("/me/2fa/enable", requireUser(), enableTotp);
api.post("/me/2fa/disable", requireUser(), disableTotp);
api.post("/me/2fa/recovery-codes", requireUser(), regenerateRecoveryCodes);

api.get("/summary", requireUser(), summary);
api.get("/machines", requireUser(), listMachines);
api.patch("/machines/:id", requireUser("admin"), renameMachine);
api.delete("/machines/:id", requireUser("admin"), revokeMachine);

api.get("/pairing", requireUser("admin"), listPairing);
api.post("/pairing/approve", requireUser("admin"), approvePairing);
api.post("/pairing/deny", requireUser("admin"), denyPairing);

api.get("/users", requireUser("admin"), listUsers);
api.post("/users", requireUser("admin"), createUser);
api.patch("/users/:id", requireUser("admin"), updateUser);
api.delete("/users/:id", requireUser("admin"), deleteUser);

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
