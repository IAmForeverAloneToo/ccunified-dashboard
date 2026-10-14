import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { fail } from "./http";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** Security headers for every response. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  h.set("strict-transport-security", "max-age=31536000");
  h.set("content-security-policy", CSP);
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/agent/")) h.set("cache-control", "no-store");
};

/**
 * Rejects state-changing browser requests that did not come from the
 * dashboard's own pages (cross-site request forgery protection, on top of
 * the SameSite=Strict session cookie).
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("origin");
    const expected = new URL(c.req.url).origin;
    if (origin !== expected) fail(403, "bad_origin");
  }
  await next();
};
