import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deriveLoginKey } from "../src/auth/client-kdf";
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from "../src/auth/totp";
import { base64url } from "../src/lib/crypto";
import { jsonInit, startWorker, type TestUser, type TestWorker } from "./harness";

describe("login key derivation (shared with the dashboard and the Go wizard)", () => {
  const doc = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../schema/test-vectors/login-kdf.json"), "utf8"),
  ) as { vectors: { install_id: string; username: string; password: string; login_key: string }[] };

  test.each(doc.vectors)("matches the vector for $username", async (v) => {
    const key = await deriveLoginKey(v.password, v.install_id, v.username);
    expect(base64url(key)).toBe(v.login_key);
  });
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; we use 6 digits.
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  test.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i gives %s", async (t, code) => {
    expect(await totpAt(secret, Math.floor(t / 30))).toBe(code);
  });

  test("base32 round-trips", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  test("accepts one step of clock drift, refuses reuse and older codes", async () => {
    const now = Date.parse("2026-10-14T12:00:10Z");
    const step = currentStep(now);
    const prev = await totpAt(secret, step - 1);
    const next = await totpAt(secret, step + 1);
    const far = await totpAt(secret, step + 2);
    expect(await verifyTotp(secret, prev, null, now)).toBe(step - 1);
    expect(await verifyTotp(secret, next, null, now)).toBe(step + 1);
    expect(await verifyTotp(secret, far, null, now)).toBeNull();
    expect(await verifyTotp(secret, prev, step - 1, now)).toBeNull();
    expect(await verifyTotp(secret, "12345", null, now)).toBeNull();
  });
});

describe("two-factor login", () => {
  let w: TestWorker;
  let u: TestUser;
  let secret: string;
  let recovery: string[];

  beforeAll(async () => {
    w = await startWorker();
    u = await w.createUser({ role: "viewer" });
  });
  afterAll(() => w.dispose());

  const post = (path: string, body: unknown) =>
    w.fetch(path, { ...jsonInit("POST", body), cookie: u.cookie });

  test("setup needs the password and returns an authenticator link", async () => {
    expect((await post("/api/me/2fa/setup", { key: base64url(new Uint8Array(32)) })).status).toBe(
      401,
    );
    const res = await post("/api/me/2fa/setup", { key: u.key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string; otpauth_uri: string };
    secret = body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/ccunified%20\(localhost\)%3A/);
    expect(body.otpauth_uri).toContain(`secret=${secret}`);
  });

  test("enabling needs a correct code and returns ten recovery codes", async () => {
    expect((await post("/api/me/2fa/enable", { code: "000000" })).status).toBe(400);
    const res = await post("/api/me/2fa/enable", { code: await totpAt(secret, currentStep()) });
    expect(res.status).toBe(200);
    recovery = ((await res.json()) as { recovery_codes: string[] }).recovery_codes;
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    for (const code of recovery) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(
      (await w.fetch("/api/me", { cookie: u.cookie }).then((r) => r.json())) as object,
    ).toMatchObject({
      totp_enabled: true,
    });
  });

  test("login then asks for a code, and refuses a wrong one", async () => {
    const noCode = await w.login(u.username, u.key);
    expect(noCode.status).toBe(401);
    expect(await noCode.json()).toEqual({ error: "totp_required" });
    expect((await w.login(u.username, u.key, "123456")).status).toBe(401);
  });

  test("a code works once; the same code cannot be replayed", async () => {
    const code = await totpAt(secret, currentStep() + 1);
    expect((await w.login(u.username, u.key, code)).status).toBe(200);
    expect((await w.login(u.username, u.key, code)).status).toBe(401);
  });

  test("a recovery code works once, typed loosely", async () => {
    const code = recovery[0] ?? "";
    expect((await w.login(u.username, u.key, code.toLowerCase().replace("-", " "))).status).toBe(
      200,
    );
    expect((await w.login(u.username, u.key, code)).status).toBe(401);
  });

  test("a password alone is never enough", async () => {
    expect((await w.login(u.username, u.key, recovery[0] ?? "")).status).toBe(401);
  });

  test("turning it off needs the password and a code", async () => {
    expect((await post("/api/me/2fa/disable", { key: u.key, code: "000000" })).status).toBe(400);
    expect((await post("/api/me/2fa/disable", { key: u.key, code: recovery[1] })).status).toBe(200);
    expect((await w.login(u.username, u.key)).status).toBe(200);
  });
});
