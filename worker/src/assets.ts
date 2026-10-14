import { assets } from "virtual:dashboard-assets";
import type { Context } from "hono";
import type { AppEnv } from "./env";

/**
 * Serves the dashboard's files, which are bundled into the Worker at build
 * time. Any other GET path gets index.html, so the dashboard's own routes work
 * on reload.
 */
export function serveAsset(c: Context<AppEnv>): Response {
  const path = new URL(c.req.url).pathname;
  const file = assets[path];
  if (file) {
    // Vite puts a content hash in every file name under /assets/.
    const immutable = path.startsWith("/assets/");
    return new Response(file.body, {
      headers: {
        "content-type": file.type,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }
  const index = assets["/index.html"];
  if (!index) return c.text("Dashboard not built", 503);
  return new Response(index.body, {
    headers: { "content-type": index.type, "cache-control": "no-cache" },
  });
}
