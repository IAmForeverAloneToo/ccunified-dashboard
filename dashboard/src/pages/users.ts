import { ApiError, api, type User } from "../lib/api";
import { confirmDialog, h, openDialog, toast } from "../lib/dom";
import { dateTime, relativeTime } from "../lib/format";
import { checkNewPassword, loginKey, MIN_PASSWORD_LENGTH } from "../lib/password";
import type { PageContext } from "../main";

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

/** A dialog asking for a temporary password (twice); resolves with its login key. */
async function askTemporaryPassword(
  username: string,
  title: string,
  intro: string,
): Promise<string | undefined> {
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  const error = h("p", { class: "field-error", role: "alert" });
  let key: string | undefined;
  await openDialog((close) => {
    const save = h("button", { type: "submit", class: "primary" }, "Set password");
    const form = h(
      "form",
      { class: "stack", novalidate: true },
      h("h2", null, title),
      h("p", { class: "secondary" }, intro),
      h(
        "label",
        null,
        "Temporary password",
        h(
          "span",
          { class: "hint" },
          `At least ${MIN_PASSWORD_LENGTH} characters. They'll choose their own when they log in.`,
        ),
        pw,
      ),
      h("label", null, "Repeat it", pw2),
      error,
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => close() }, "Cancel"),
        save,
      ),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const problem = checkNewPassword(pw.value, pw2.value, username);
      if (problem) {
        error.textContent = problem;
        return;
      }
      save.disabled = true;
      save.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Working…");
      key = await loginKey(username, pw.value);
      close("ok");
    });
    queueMicrotask(() => pw.focus());
    return form;
  });
  return key;
}

export async function usersPage(ctx: PageContext) {
  const listCard = h("section", { class: "card", "aria-labelledby": "users-title" });

  // ---- Add user ----
  const username = h("input", { autocomplete: "off", spellcheck: false, autocapitalize: "none" });
  const role = h(
    "select",
    null,
    h("option", { value: "viewer" }, "Viewer: can see everything, change nothing"),
    h("option", { value: "admin" }, "Admin: can also manage users and machines"),
  );
  const addError = h("p", { class: "field-error", role: "alert" });
  const addButton = h("button", { type: "submit", class: "primary" }, "Add user…");
  const addForm = h(
    "form",
    { class: "form", novalidate: true },
    h(
      "label",
      null,
      "Username",
      h(
        "span",
        { class: "hint" },
        "3–32 letters, digits, dots, dashes or underscores. Can't be changed later.",
      ),
      username,
    ),
    h("label", null, "Role", role),
    addError,
    h("div", { class: "row" }, addButton),
  );
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    addError.textContent = "";
    if (!USERNAME_RE.test(username.value)) {
      addError.textContent = "Use 3–32 letters, digits, dots, dashes or underscores.";
      return;
    }
    const key = await askTemporaryPassword(
      username.value,
      `Password for ${username.value}`,
      "Give this temporary password to them privately.",
    );
    if (!key) return;
    try {
      await api("/users", {
        method: "POST",
        body: { username: username.value, role: role.value, key },
      });
      toast(`Added ${username.value}`);
      addForm.reset();
      await load();
    } catch (e) {
      addError.textContent =
        e instanceof ApiError && e.code === "username_taken"
          ? "That username is already taken."
          : "Couldn't add the user. Check the username.";
    }
  });

  async function change(user: User, body: Record<string, unknown>, done: string) {
    try {
      await api(`/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body });
      toast(done);
      await load();
    } catch (e) {
      toast(
        e instanceof ApiError && e.code === "last_admin"
          ? "There must always be at least one active admin."
          : "Couldn't save the change.",
      );
    }
  }

  async function load() {
    const { users } = await api<{ users: User[] }>("/users");
    listCard.replaceChildren(
      h(
        "div",
        { class: "card-head" },
        h("h2", { id: "users-title" }, `${users.length} user${users.length === 1 ? "" : "s"}`),
      ),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["Username", "Role", "Two-factor", "Last login", "Status"].map((t) =>
                h("th", { scope: "col" }, t),
              ),
              h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")),
            ),
          ),
          h(
            "tbody",
            null,
            users.map((u) => {
              const self = u.id === ctx.me.id;
              const status =
                u.disabled_at !== null
                  ? "Disabled"
                  : u.must_change_password
                    ? "Must set password"
                    : "Active";
              return h(
                "tr",
                { class: u.disabled_at !== null ? "dim" : undefined },
                h(
                  "th",
                  { scope: "row" },
                  u.username,
                  self ? h("span", { class: "muted" }, " (you)") : null,
                ),
                h("td", null, u.role === "admin" ? "Admin" : "Viewer"),
                h("td", null, u.totp_enabled ? "On" : "Off"),
                h("td", { title: dateTime(u.last_login_at) }, relativeTime(u.last_login_at)),
                h("td", null, status),
                h(
                  "td",
                  null,
                  self
                    ? h("a", { href: "/account", class: "small" }, "Manage on your account page")
                    : h(
                        "div",
                        { class: "row" },
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small",
                            onclick: () =>
                              change(
                                u,
                                { role: u.role === "admin" ? "viewer" : "admin" },
                                `${u.username} is now ${u.role === "admin" ? "a viewer" : "an admin"}`,
                              ),
                          },
                          u.role === "admin" ? "Make viewer" : "Make admin",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small",
                            onclick: async () => {
                              const key = await askTemporaryPassword(
                                u.username,
                                `Reset ${u.username}'s password`,
                                "They'll be signed out and must choose a new password at next login.",
                              );
                              if (key) await change(u, { key }, `Password reset for ${u.username}`);
                            },
                          },
                          "Reset password",
                        ),
                        u.totp_enabled
                          ? h(
                              "button",
                              {
                                type: "button",
                                class: "small",
                                onclick: async () => {
                                  const ok = await confirmDialog({
                                    title: `Turn off two-factor for ${u.username}?`,
                                    body: "Only do this if they lost their authenticator and recovery codes. They can turn it back on from their account page.",
                                    confirm: "Turn off",
                                    danger: true,
                                  });
                                  if (ok)
                                    await change(
                                      u,
                                      { reset_2fa: true },
                                      `Two-factor turned off for ${u.username}`,
                                    );
                                },
                              },
                              "Reset two-factor",
                            )
                          : null,
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small",
                            onclick: () =>
                              change(
                                u,
                                { disabled: u.disabled_at === null },
                                u.disabled_at === null
                                  ? `${u.username} disabled`
                                  : `${u.username} enabled`,
                              ),
                          },
                          u.disabled_at === null ? "Disable" : "Enable",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small danger",
                            onclick: async () => {
                              const ok = await confirmDialog({
                                title: `Delete ${u.username}?`,
                                body: "They lose access immediately. This can't be undone.",
                                confirm: "Delete",
                                danger: true,
                              });
                              if (!ok) return;
                              await api(`/users/${encodeURIComponent(u.id)}`, {
                                method: "DELETE",
                              }).catch(() => toast("Couldn't delete the user."));
                              await load();
                            },
                          },
                          "Delete",
                        ),
                      ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }

  ctx.main.append(
    h(
      "div",
      { class: "page-head" },
      h("div", null, h("h1", null, "Users"), h("p", null, "Who can log in to this dashboard.")),
    ),
    listCard,
    h(
      "section",
      { class: "card stack", "aria-labelledby": "add-user-title" },
      h("h2", { id: "add-user-title" }, "Add a user"),
      h(
        "p",
        { class: "secondary small" },
        "You'll set a temporary password; they choose their own at first login.",
      ),
      h("div", { class: "stack" }, addForm),
    ),
  );
  await load();
  return undefined;
}
