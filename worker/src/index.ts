import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { machineAuth } from "./agent/auth";
import { ingest } from "./agent/ingest";
import { pollPairing, startPairing } from "./agent/pair";
import { receivePrices } from "./agent/prices";
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  renameDepartment,
} from "./api/departments";
import { listMachines, removeMachine, revokeMachine, updateMachine } from "./api/machines";
import { approvePairing, denyPairing, listPairing } from "./api/pairing";
import { listPrices, updatePrices } from "./api/prices";
import { checkForUpdates, readSettings, updateSettings } from "./api/settings";
import { summary, usageDays } from "./api/summary";
import { createUser, deleteUser, listUsers, updateUser } from "./api/users";
import { serveAsset } from "./assets";
import { me } from "./auth/me";
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
import { INGEST_SCHEMA_VERSIONS } from "./ingest/schema";
import { sameOriginOnly, securityHeaders } from "./lib/security";
import { SERVER_VERSION } from "./version";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

app.get("/healthz", (c) =>
  c.json({ ok: true, version: SERVER_VERSION, schema_versions: INGEST_SCHEMA_VERSIONS }),
);

// Machines: pairing (no key yet) and uploads (upload key).
app.post("/agent/pair/start", startPairing);
app.post("/agent/pair/poll", pollPairing);
app.post("/agent/ingest", machineAuth, ingest);
app.post("/agent/prices", machineAuth, receivePrices);

// Dashboard API (browser session).
const api = new Hono<AppEnv>();
api.use("*", sameOriginOnly);

api.get("/login-params", loginParams);
api.post("/login", login);
api.post("/logout", logout);

const pendingOk = { beforePasswordChange: true };
api.get("/me", requireUser("user", pendingOk), me);
api.post("/me/password", requireUser("user", pendingOk), changePassword);
api.post("/me/2fa/setup", requireUser(), startTotpSetup);
api.post("/me/2fa/enable", requireUser(), enableTotp);
api.post("/me/2fa/disable", requireUser(), disableTotp);
api.post("/me/2fa/recovery-codes", requireUser(), regenerateRecoveryCodes);

api.get("/summary", requireUser(), summary);
api.get("/usage-days", requireUser(), usageDays);
api.get("/machines", requireUser(), listMachines);
// Who sees and manages which machines and users is decided within each
// route (see auth/access.ts).
api.patch("/machines/:id", requireUser(), updateMachine);
api.post("/machines/:id/revoke", requireUser(), revokeMachine);
api.delete("/machines/:id", requireUser(), removeMachine);

api.get("/departments", requireUser(), listDepartments);
api.post("/departments", requireUser("admin"), createDepartment);
api.patch("/departments/:id", requireUser("admin"), renameDepartment);
api.delete("/departments/:id", requireUser("admin"), deleteDepartment);

api.get("/pairing", requireUser("admin"), listPairing);
api.post("/pairing/approve", requireUser(), approvePairing);
api.post("/pairing/deny", requireUser(), denyPairing);

api.get("/users", requireUser(), listUsers);
api.post("/users", requireUser(), createUser);
api.patch("/users/:id", requireUser(), updateUser);
api.delete("/users/:id", requireUser(), deleteUser);

api.get("/settings", requireUser("dashboard"), readSettings);
api.patch("/settings", requireUser("admin"), updateSettings);
api.post("/settings/check-updates", requireUser("dashboard"), checkForUpdates);
api.get("/prices", requireUser("dashboard"), listPrices);
api.patch("/prices", requireUser("admin"), updatePrices);

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
