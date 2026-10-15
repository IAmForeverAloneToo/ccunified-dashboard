import { describeAccess, isAdmin, managedDepartments } from "../lib/access";
import {
  ApiError,
  api,
  type DashboardRole,
  type Department,
  type DepartmentRole,
  type User,
} from "../lib/api";
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

/** Someone's access: a dashboard-wide role and a role in some departments. */
interface Access {
  role: DashboardRole | null;
  departments: { id: string; role: DepartmentRole }[];
}

/**
 * The department roles worth offering: admins already see and manage every
 * department, viewers already see every machine (a role can still make them
 * a manager, or let them own machines), managers give only Viewer or Member.
 */
function departmentChoices(adminCaller: boolean, role: DashboardRole | null): [string, string][] {
  if (!adminCaller) {
    return [
      ["", "No role"],
      ["member", "Member"],
      ["viewer", "Viewer"],
    ];
  }
  if (role === "viewer") {
    return [
      ["", "No role"],
      ["member", "Member: can own its machines"],
      ["manager", "Manager"],
    ];
  }
  return [
    ["", "No role"],
    ["member", "Member"],
    ["viewer", "Viewer"],
    ["manager", "Manager"],
  ];
}

const DEPARTMENT_HINT: Record<"none" | "viewer" | "managerCaller", string> = {
  none: "Members see the machines they own; viewers see all of its machines; managers also manage its machines and people.",
  viewer:
    "They already see every machine. A department role can make them its manager, or let them own its machines.",
  managerCaller: "Members see the machines they own; viewers see all of its machines.",
};

/**
 * Fields for choosing someone's access. Admins pick a dashboard-wide role and
 * the department roles that still mean something with it; managers pick
 * Viewer or Member in the departments they manage.
 */
function accessFields(opts: {
  admin: boolean;
  departments: { id: string; name: string }[];
  initial: Access;
}) {
  const role = h(
    "select",
    { "aria-describedby": "role-hint" },
    h("option", { value: "" }, "None: only the departments below"),
    h("option", { value: "viewer" }, "Viewer: sees every machine, changes nothing"),
    h("option", { value: "admin" }, "Admin: manages everything"),
  );
  role.value = opts.initial.role ?? "";
  const currentRole = () => (opts.admin ? ((role.value || null) as DashboardRole | null) : null);
  const selects = opts.departments.map((d) => {
    const select = h("select", { "aria-label": `Role in ${d.name}` });
    return {
      id: d.id,
      name: d.name,
      select,
      wanted: opts.initial.departments.find((x) => x.id === d.id)?.role ?? "",
    };
  });
  const hint = h("p", { class: "hint" });
  const adminNote = h(
    "p",
    { class: "secondary small" },
    "Admins see and manage every department, and can own machines in any of them.",
  );
  const fieldset =
    selects.length > 0
      ? h(
          "fieldset",
          { class: "access-departments" },
          h("legend", null, opts.admin ? "Roles in departments" : "Role in your departments"),
          hint,
          selects.map((x) =>
            h("label", { class: "access-row" }, h("span", null, x.name), x.select),
          ),
        )
      : null;

  /** Offers the department roles that fit the dashboard-wide role, keeping picks that still do. */
  function paint() {
    const r = currentRole();
    const choices = departmentChoices(opts.admin, r);
    for (const x of selects) {
      const keep = x.select.value || x.wanted;
      x.select.replaceChildren(...choices.map(([value, label]) => h("option", { value }, label)));
      x.select.value = choices.some(([value]) => value === keep) ? keep : "";
      x.wanted = "";
    }
    hint.textContent =
      DEPARTMENT_HINT[!opts.admin ? "managerCaller" : r === "viewer" ? "viewer" : "none"];
    if (fieldset) fieldset.hidden = r === "admin";
    adminNote.hidden = r !== "admin";
  }
  role.addEventListener("change", paint);
  paint();

  const element = h(
    "div",
    { class: "stack" },
    opts.admin
      ? h(
          "label",
          null,
          "Dashboard-wide role",
          h("span", { class: "hint", id: "role-hint" }, "Applies to every machine and department."),
          role,
        )
      : null,
    opts.admin ? adminNote : null,
    fieldset ?? h("p", { class: "secondary small" }, "There are no departments yet."),
  );
  return {
    element,
    value(): Access {
      const r = currentRole();
      return {
        role: r,
        // Admins need no department roles.
        departments:
          r === "admin"
            ? []
            : selects
                .filter((x) => x.select.value !== "")
                .map((x) => ({ id: x.id, role: x.select.value as DepartmentRole })),
      };
    },
  };
}

export async function usersPage(ctx: PageContext) {
  const admin = isAdmin(ctx.me);
  const listCard = h("section", { class: "card", "aria-labelledby": "users-title" });
  const { departments } = await api<{ departments: Department[] }>("/departments");
  const names = new Map(departments.map((d) => [d.id, d.name]));
  // The departments whose roles this person can give.
  const grantable = admin
    ? departments
    : departments.filter((d) => managedDepartments(ctx.me).some((m) => m.id === d.id));

  const errorText = (e: unknown) => {
    if (!(e instanceof ApiError)) return "Couldn't save the change.";
    if (e.code === "last_admin") return "There must always be at least one active admin.";
    if (e.code === "department_required")
      return "Give them a role in at least one of your departments.";
    if (e.code === "username_taken") return "That username is already taken.";
    return "Couldn't save the change.";
  };

  // ---- Add user ----
  const username = h("input", { autocomplete: "off", spellcheck: false, autocapitalize: "none" });
  // New users start with no dashboard-wide role once there are departments
  // to give them a role in.
  const newAccess = (): Access => ({
    role: admin && departments.length === 0 ? "viewer" : null,
    departments: [],
  });
  let addAccess = accessFields({ admin, departments: grantable, initial: newAccess() });
  const accessSlot = h("div", null, addAccess.element);
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
    accessSlot,
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
    const access = addAccess.value();
    if (access.role === null && access.departments.length === 0) {
      addError.textContent = admin
        ? "Give them a dashboard-wide role or a role in a department."
        : "Give them a role in at least one of your departments.";
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
        body: { username: username.value, ...access, key },
      });
      toast(`Added ${username.value}`);
      addForm.reset();
      addAccess = accessFields({ admin, departments: grantable, initial: newAccess() });
      accessSlot.replaceChildren(addAccess.element);
      await load();
    } catch (e) {
      addError.textContent =
        e instanceof ApiError && e.code === "invalid_request"
          ? "Couldn't add the user. Check the username."
          : errorText(e);
    }
  });

  async function change(user: User, body: Record<string, unknown>, done: string) {
    try {
      await api(`/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body });
      toast(done);
      await load();
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function editAccess(user: User) {
    const fields = accessFields({ admin, departments: grantable, initial: user });
    const error = h("p", { class: "field-error", role: "alert" });
    let access: Access | undefined;
    await openDialog((close) => {
      const form = h(
        "form",
        { class: "stack", novalidate: true },
        h("h2", null, `${user.username}'s access`),
        fields.element,
        error,
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "primary" }, "Save"),
        ),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = fields.value();
        if (!admin && value.departments.length === 0) {
          error.textContent = "Give them a role in at least one of your departments.";
          return;
        }
        access = value;
        close("ok");
      });
      return form;
    });
    if (!access) return;
    // The dashboard-wide role only when it changes: changing it signs them out.
    await change(
      user,
      admin && access.role !== user.role
        ? { role: access.role, departments: access.departments }
        : { departments: access.departments },
      `Saved ${user.username}'s access`,
    );
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
              ["Username", "Access", "Two-factor", "Last login", "Status"].map((t) =>
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
              const access = describeAccess(
                u.role,
                u.departments.map((d) => ({ name: names.get(d.id) ?? "?", role: d.role })),
              );
              return h(
                "tr",
                { class: u.disabled_at !== null ? "dim" : undefined },
                h(
                  "th",
                  { scope: "row" },
                  u.username,
                  self ? h("span", { class: "muted" }, " (you)") : null,
                ),
                h("td", null, access),
                h("td", null, u.totp_enabled ? "On" : "Off"),
                h("td", { title: dateTime(u.last_login_at) }, relativeTime(u.last_login_at)),
                h("td", null, status),
                h(
                  "td",
                  null,
                  self
                    ? h("a", { href: "/account", class: "small" }, "Manage on your account page")
                    : !u.can_manage
                      ? h("span", { class: "muted small" }, admin ? "" : "Managed by an admin")
                      : h(
                          "div",
                          { class: "row" },
                          h(
                            "button",
                            { type: "button", class: "small", onclick: () => editAccess(u) },
                            "Access…",
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
                                if (key)
                                  await change(u, { key }, `Password reset for ${u.username}`);
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
                                  body: "They lose access immediately, and machines they own become shared. This can't be undone.",
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
      h(
        "div",
        null,
        h("h1", null, "Users"),
        h(
          "p",
          null,
          admin
            ? "Who can log in to this dashboard, and what they can see."
            : "The people in the departments you manage.",
        ),
      ),
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
