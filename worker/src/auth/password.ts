import { base64url, fromBase64url, randomBytes, timingSafeEqual } from "../lib/crypto";

// Server side of password checking. The browser has already stretched the
// password into a 32-byte login key (see client-kdf.ts); here it gets one more
// salted PBKDF2 pass so the database never holds anything that could be
// replayed as a login key.
//
// Stored format: "v1$<iterations>$<salt>$<hash>" (salt and hash base64url).

const SERVER_ITERATIONS = 5_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** A login key as sent by the browser: 32 bytes, base64url (43 characters). */
export const LOGIN_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function decodeLoginKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!LOGIN_KEY_RE.test(value)) return undefined;
  const bytes = fromBase64url(value);
  return bytes?.length === 32 ? bytes : undefined;
}

async function pbkdf2(
  key: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", key, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashLoginKey(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(key, salt, SERVER_ITERATIONS);
  return `v1$${SERVER_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyLoginKey(
  stored: string,
  key: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const [version, iterations, salt, hash] = stored.split("$");
  const n = Number(iterations);
  const saltBytes = salt ? fromBase64url(salt) : undefined;
  const expected = hash ? fromBase64url(hash) : undefined;
  if (version !== "v1" || !Number.isInteger(n) || n < 1 || n > 100_000 || !saltBytes || !expected) {
    return false;
  }
  return timingSafeEqual(await pbkdf2(key, saltBytes, n), expected);
}

const DUMMY_HASH = `v1$${SERVER_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/** Spends the same time as a real check, so unknown usernames can't be told apart by timing. */
export async function burnLoginCheck(key: Uint8Array<ArrayBuffer>): Promise<void> {
  await verifyLoginKey(DUMMY_HASH, key);
}
