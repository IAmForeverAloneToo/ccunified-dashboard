const encoder = new TextEncoder();

/** URL-safe base64 without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A random secret with `bytes` bytes of entropy, base64url-encoded. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a UTF-8 string, hex-encoded. Used to store tokens without storing the tokens. */
export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time comparison of two equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Decodes URL-safe base64 (padding optional). Returns undefined for malformed input. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}
