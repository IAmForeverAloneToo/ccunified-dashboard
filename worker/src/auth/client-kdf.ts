// Browser-side password stretching. This file is shared by the Worker (tests)
// and the dashboard, and mirrored by the Go setup wizard; the test vectors in
// schema/test-vectors/login-kdf.json keep all three identical.
//
// The browser turns a password into a 32-byte "login key" with 600,000 rounds
// of PBKDF2-SHA256 (OWASP's 2023+ recommendation). Only the login key is sent;
// the password never leaves the browser. The Worker stores a salted hash of
// the login key, so a copy of the database is as slow to brute-force as if
// the server itself had done all 600,000 rounds — without needing more CPU
// than Cloudflare's free plan allows per request.

export const LOGIN_KDF = {
  version: "v1",
  iterations: 600_000,
  keyBytes: 32,
} as const;

const encoder = new TextEncoder();

/**
 * Per-user salt: SHA-256 of "ccunified-login-v1|<install_id>|<lowercase username>".
 * It is computable before login, so no salt lookup can reveal which usernames exist.
 */
export async function loginSalt(
  installId: string,
  username: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = `ccunified-login-${LOGIN_KDF.version}|${installId}|${username.toLowerCase()}`;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/** Derives the login key the browser sends instead of the password. */
export async function deriveLoginKey(
  password: string,
  installId: string,
  username: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: await loginSalt(installId, username),
      iterations: LOGIN_KDF.iterations,
    },
    material,
    LOGIN_KDF.keyBytes * 8,
  );
  return new Uint8Array(bits);
}
