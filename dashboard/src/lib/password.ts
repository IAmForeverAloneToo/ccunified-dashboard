import { deriveLoginKey } from "../../../worker/src/auth/client-kdf";
import { base64url } from "../../../worker/src/lib/crypto";
import { api } from "./api";

// The password never leaves the browser: it is stretched here into a login
// key (600,000 rounds of PBKDF2), and only that key is sent.

export const MIN_PASSWORD_LENGTH = 10;

let params: Promise<{ install_id: string }> | undefined;

function loginParams() {
  if (!params) {
    const p = api<{ install_id: string }>("/login-params", { quietAuth: true });
    params = p;
    // A failed fetch isn't kept: the next try asks again.
    p.catch(() => {
      if (params === p) params = undefined;
    });
  }
  return params;
}

export async function loginKey(username: string, password: string): Promise<string> {
  const { install_id } = await loginParams();
  return base64url(await deriveLoginKey(password, install_id, username));
}

/** Returns an error message, or undefined if the new password is acceptable. */
export function checkNewPassword(
  password: string,
  confirm: string,
  username: string,
): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.toLowerCase() === username.toLowerCase())
    return "Don't use your username as your password.";
  if (password !== confirm) return "The two passwords don't match.";
  return undefined;
}
