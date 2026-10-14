import { ApiError, api } from "../lib/api";
import { h, toast } from "../lib/dom";
import { logo } from "../lib/logo";
import { checkNewPassword, loginKey, MIN_PASSWORD_LENGTH } from "../lib/password";
import type { PageContext } from "../main";

/** A change-password form, used on its own page (forced) and on the Account page. */
export function passwordForm(ctx: Pick<PageContext, "me">, onDone: () => void): HTMLFormElement {
  const current = h("input", {
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const next = h("input", { type: "password", autocomplete: "new-password", required: true });
  const confirm = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "field-error", role: "alert" });
  const button = h("button", { type: "submit", class: "primary" }, "Change password");

  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("label", null, "Current password", current),
    h(
      "label",
      null,
      "New password",
      h(
        "span",
        { class: "hint" },
        `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`,
      ),
      next,
    ),
    h("label", null, "Repeat new password", confirm),
    error,
    h("div", { class: "row" }, button),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const problem = checkNewPassword(next.value, confirm.value, ctx.me.username);
    if (problem) {
      error.textContent = problem;
      return;
    }
    button.disabled = true;
    button.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Saving…");
    try {
      const [currentKey, newKey] = await Promise.all([
        loginKey(ctx.me.username, current.value),
        loginKey(ctx.me.username, next.value),
      ]);
      await api("/me/password", {
        method: "POST",
        body: { current_key: currentKey, new_key: newKey },
      });
      form.reset();
      toast("Password changed. Your other sessions were signed out.");
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_credentials") {
        error.textContent = "Your current password is wrong.";
      } else if (e instanceof ApiError && e.code === "same_password") {
        error.textContent = "Choose a password different from your current one.";
      } else if (e instanceof ApiError && e.code === "too_many_attempts") {
        error.textContent = "Too many failed attempts. Try again later.";
      } else {
        error.textContent = "Couldn't change your password. Try again.";
      }
    } finally {
      button.disabled = false;
      button.textContent = "Change password";
    }
  });
  return form;
}

/** Shown when an admin set your password: you must choose your own first. */
export function changePasswordPage(ctx: PageContext) {
  const forced = ctx.me.must_change_password;
  ctx.main.append(
    h(
      "div",
      { class: "card auth-card" },
      h("div", { class: "brand" }, logo(), "ccunified"),
      h(
        "div",
        { class: "stack" },
        h("h1", null, "Choose a new password"),
        h(
          "p",
          { class: "secondary" },
          forced
            ? `Hi ${ctx.me.username}. Your password was set by an admin, so please choose your own before continuing.`
            : "Choose a new password.",
        ),
      ),
      passwordForm(ctx, async () => {
        await ctx.refreshMe();
        ctx.navigate("/", true);
      }),
    ),
  );
  return undefined;
}
