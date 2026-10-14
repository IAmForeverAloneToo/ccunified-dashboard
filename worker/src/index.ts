import { Hono } from "hono";
import type { Env } from "./env";
import { SERVER_VERSION } from "./version";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, version: SERVER_VERSION }));

export default app;
