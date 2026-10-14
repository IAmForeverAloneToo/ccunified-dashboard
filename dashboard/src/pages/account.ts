import { encode } from "uqr";
import { ApiError, api } from "../lib/api";
import { type Child, fill, h, openDialog, s, toast } from "../lib/dom";
import { loginKey } from "../lib/password";
import type { PageContext } from "../main";
import { passwordForm } from "./change-password";

/** Draws a QR code as SVG squares (no markup strings involved). */
function qrCode(text: string): SVGSVGElement {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  const svg = s("svg", {
    class: "qr",
    viewBox: `0 0 ${size} ${size}`,
    role: "img",
    "aria-label": "QR code for your authenticator app",
    "shape-rendering": "crispEdges",
  });
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) svg.append(s("rect", { x, y, width: 1, height: 1 }));
    });
  });
  return svg;
}

function recoveryCodesView(codes: string[]): Child[] {
  const text = `ccunified recovery codes for ${location.host}\nEach code works once.\n\n${codes.join("\n")}\n`;
  return [
    h(
      "p",
      { class: "secondary" },
      "Save these recovery codes somewhere safe. Each one lets you log in once if you lose your phone. They won't be shown again.",
    ),
    h(
      "div",
      { class: "codes" },
      codes.map((c) => h("span", null, c)),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          type: "button",
          class: "small",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast("Copied");
            } catch {
              toast("Couldn't copy. Select the codes and copy them yourself.");
            }
          },
        },
        "Copy",
      ),
      h(
        "button",
        {
          type: "button",
          class: "small",
          onclick: () => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const a = h("a", { href: url, download: "ccunified-recovery-codes.txt" });
            a.click();
            URL.revokeObjectURL(url);
          },
        },
        "Download",
      ),
    ),
  ];
}

export async function accountPage(ctx: PageContext) {
  const twoFactor = h("section", { class: "card stack", "aria-labelledby": "tf-title" });

  /** Dialog: password (+ code) → runs `action` with the login key and code. */
  async function confirmWithPassword(
    title: string,
    intro: string,
    needsCode: boolean,
    action: (
      key: string,
      code: string,
      close: (value?: string) => void,
    ) => Promise<Child | undefined>,
    options: { ownButtons?: boolean } = {},
  ) {
    const pw = h("input", { type: "password", autocomplete: "current-password" });
    const code = h("input", {
      autocomplete: "one-time-code",
      spellcheck: false,
      placeholder: "123456",
    });
    const error = h("p", { class: "field-error", role: "alert" });
    await openDialog((close) => {
      const go = h("button", { type: "submit", class: "primary" }, "Continue");
      const body = h("div", { class: "stack" });
      const form = h(
        "form",
        { class: "stack", novalidate: true },
        h("h2", null, title),
        h("p", { class: "secondary" }, intro),
        h("label", null, "Your password", pw),
        needsCode
          ? h(
              "label",
              null,
              "Authentication code",
              h("span", { class: "hint" }, "From your app, or a recovery code."),
              code,
            )
          : null,
        error,
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", onclick: () => close() }, "Cancel"),
          go,
        ),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        go.disabled = true;
        go.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Checking…");
        try {
          const key = await loginKey(ctx.me.username, pw.value);
          const result = await action(key, code.value.trim(), close);
          if (result) {
            form.replaceWith(body);
            fill(
              body,
              result,
              options.ownButtons
                ? null
                : h(
                    "div",
                    { class: "dialog-actions" },
                    h(
                      "button",
                      { type: "button", class: "primary", onclick: () => close("ok") },
                      "Done",
                    ),
                  ),
            );
          } else {
            close("ok");
          }
        } catch (e) {
          error.textContent =
            e instanceof ApiError && e.code === "invalid_credentials"
              ? "Wrong password."
              : e instanceof ApiError && e.code === "invalid_code"
                ? "That code didn't work."
                : e instanceof ApiError && e.code === "too_many_attempts"
                  ? "Too many failed attempts. Try again later."
                  : "Something went wrong. Try again.";
        } finally {
          go.disabled = false;
          go.textContent = "Continue";
        }
      });
      queueMicrotask(() => pw.focus());
      return form;
    });
    await ctx.refreshMe();
    await drawTwoFactor();
  }

  async function setUp() {
    await confirmWithPassword(
      "Set up two-factor",
      "Confirm your password to start.",
      false,
      async (key, _code, close) => {
        const setup = await api<{ secret: string; otpauth_uri: string }>("/me/2fa/setup", {
          method: "POST",
          body: { key },
        });
        const code = h("input", {
          autocomplete: "one-time-code",
          inputMode: "numeric",
          placeholder: "123456",
        });
        const error = h("p", { class: "field-error", role: "alert" });
        const result = h("div", { class: "stack" });
        const verify = h("button", { type: "submit", class: "primary" }, "Turn on");
        const form = h(
          "form",
          { class: "stack", novalidate: true },
          h("h2", null, "Set up two-factor"),
          h(
            "p",
            { class: "secondary" },
            "1. Scan this with an authenticator app (Google Authenticator, 1Password, Authy, …):",
          ),
          qrCode(setup.otpauth_uri),
          h(
            "p",
            { class: "small secondary" },
            "Can't scan? Enter this key: ",
            h("code", null, setup.secret.replace(/(.{4})/g, "$1 ").trim()),
          ),
          h("label", null, "2. Enter the 6-digit code it shows", code),
          error,
          h(
            "div",
            { class: "dialog-actions" },
            h("button", { type: "button", onclick: () => close() }, "Cancel"),
            verify,
          ),
        );
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          error.textContent = "";
          try {
            const res = await api<{ recovery_codes: string[] }>("/me/2fa/enable", {
              method: "POST",
              body: { code: code.value.trim() },
            });
            form.replaceWith(result);
            fill(
              result,
              h("h2", null, "Two-factor is on"),
              recoveryCodesView(res.recovery_codes),
              h(
                "div",
                { class: "dialog-actions" },
                h(
                  "button",
                  { type: "button", class: "primary", onclick: () => close("ok") },
                  "Done",
                ),
              ),
            );
          } catch {
            error.textContent =
              "That code didn't work. Check the time on your phone and try the newest code.";
          }
        });
        return form;
      },
      { ownButtons: true },
    );
  }

  async function drawTwoFactor() {
    const on = ctx.me.totp_enabled;
    twoFactor.replaceChildren(
      h("h2", { id: "tf-title" }, "Two-factor authentication"),
      h(
        "p",
        { class: "secondary" },
        on
          ? "On. Logging in needs your password and a code from your authenticator app."
          : "Off. Turn it on so a stolen password alone can't get into the dashboard.",
      ),
      h(
        "div",
        { class: "row" },
        on
          ? [
              h(
                "button",
                {
                  type: "button",
                  onclick: () =>
                    confirmWithPassword(
                      "New recovery codes",
                      "Your old recovery codes will stop working.",
                      true,
                      async (key, code) => {
                        const res = await api<{ recovery_codes: string[] }>(
                          "/me/2fa/recovery-codes",
                          {
                            method: "POST",
                            body: { key, code },
                          },
                        );
                        return recoveryCodesView(res.recovery_codes);
                      },
                    ),
                },
                "New recovery codes",
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: () =>
                    confirmWithPassword(
                      "Turn off two-factor",
                      "You'll only need your password to log in.",
                      true,
                      async (key, code) => {
                        await api("/me/2fa/disable", { method: "POST", body: { key, code } });
                        toast("Two-factor turned off");
                        return undefined;
                      },
                    ),
                },
                "Turn off",
              ),
            ]
          : h("button", { type: "button", class: "primary", onclick: setUp }, "Set up two-factor"),
      ),
    );
  }

  ctx.main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Your account"),
        h("p", null, `${ctx.me.username} · ${ctx.me.role === "admin" ? "Admin" : "Viewer"}`),
      ),
    ),
    h(
      "section",
      { class: "card stack", "aria-labelledby": "pw-title" },
      h("h2", { id: "pw-title" }, "Password"),
      h("p", { class: "secondary" }, "Changing your password signs you out everywhere else."),
      passwordForm(ctx, () => undefined),
    ),
    twoFactor,
  );
  await drawTwoFactor();
  return undefined;
}
