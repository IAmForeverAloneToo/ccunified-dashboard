import { ApiError, api, type Me } from "../lib/api";
import { h } from "../lib/dom";
import { logo } from "../lib/logo";
import { loginKey } from "../lib/password";

interface LoginResponse {
  user: Me;
}

/** The login page: username + password, then an authenticator code if two-factor is on. */
export function loginPage(root: HTMLElement, query: URLSearchParams, onSuccess: (me: Me) => void) {
  const username = h("input", {
    name: "username",
    autocomplete: "username",
    required: true,
    autocapitalize: "none",
    spellcheck: false,
  });
  const password = h("input", {
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const code = h("input", {
    name: "code",
    autocomplete: "one-time-code",
    inputMode: "text",
    placeholder: "123456",
    spellcheck: false,
  });
  const codeField = h(
    "label",
    { hidden: true },
    "Authentication code",
    h("span", { class: "hint" }, "From your authenticator app, or one of your recovery codes."),
    code,
  );
  const error = h("p", { class: "field-error", role: "alert" });
  const button = h("button", { type: "submit", class: "primary" }, "Log in");
  const expired = query.get("expired") === "1";

  // The stretched key is kept between the password step and the code step,
  // so the slow derivation runs only once.
  let derived: { username: string; password: string; key: string } | undefined;

  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("label", null, "Username", username),
    h("label", null, "Password", password),
    codeField,
    error,
    button,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (!username.value || !password.value) {
      error.textContent = "Enter your username and password.";
      return;
    }
    button.disabled = true;
    button.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Logging in…");
    try {
      if (!derived || derived.username !== username.value || derived.password !== password.value) {
        derived = {
          username: username.value,
          password: password.value,
          key: await loginKey(username.value, password.value),
        };
      }
      const body: Record<string, string> = { username: username.value, key: derived.key };
      if (!codeField.hidden && code.value.trim()) body.code = code.value.trim();
      const res = await api<LoginResponse>("/login", { method: "POST", body, quietAuth: true });
      onSuccess(res.user);
    } catch (e) {
      if (!(e instanceof ApiError)) {
        error.textContent = "Couldn't reach the dashboard. Check your connection and try again.";
      } else if (e.code === "totp_required") {
        codeField.hidden = false;
        code.focus();
      } else if (e.code === "invalid_code") {
        error.textContent = "That code didn't work. Codes change every 30 seconds.";
        code.select();
      } else if (e.code === "too_many_attempts") {
        const minutes = Math.ceil(Number(e.body.retry_after_seconds ?? 900) / 60);
        error.textContent = `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
      } else if (e.code === "invalid_credentials") {
        error.textContent = "Wrong username or password.";
      } else {
        error.textContent = "Couldn't log in. Try again.";
      }
    } finally {
      button.disabled = false;
      button.textContent = "Log in";
    }
  });

  root.replaceChildren(
    h(
      "main",
      { class: "auth-page" },
      h(
        "div",
        { class: "card auth-card" },
        h("div", { class: "brand" }, logo(), "ccunified"),
        h(
          "div",
          { class: "stack" },
          h("h1", null, "Log in"),
          h("p", { class: "secondary" }, "Claude Code usage across your machines."),
        ),
        expired ? h("p", { class: "banner info" }, "Your session ended. Log in again.") : null,
        form,
      ),
    ),
  );
  username.focus();
  return undefined;
}
