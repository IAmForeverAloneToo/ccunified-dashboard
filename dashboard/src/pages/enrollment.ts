// Enrollment keys: adding many machines with a script, without anyone
// typing a code. Machines that enroll with a key wait on the Approvals page.
import { isAdmin } from "../lib/access";
import { ApiError, api, type Department, type EnrollmentKey, type Me, type User } from "../lib/api";
import { command, confirmDialog, h, openDialog, toast } from "../lib/dom";
import { dateTime, relativeTime } from "../lib/format";

const EXPIRY: [string, number | null][] = [
  ["Never", null],
  ["In 1 day", 1],
  ["In 7 days", 7],
  ["In 30 days", 30],
  ["In 90 days", 90],
  ["In 1 year", 365],
];

/** The commands that install ccunified and enroll a machine with a key. */
export function enrollCommands(repo: string, key: string): HTMLElement[] {
  const base = `https://github.com/${repo}/releases/latest/download`;
  const url = location.origin;
  const ps = `$env:CCUNIFIED_URL='${url}'; $env:CCUNIFIED_ENROLL_KEY='${key}'`;
  const sh = `CCUNIFIED_URL=${url} CCUNIFIED_ENROLL_KEY=${key}`;
  const label = (text: string) => h("p", { class: "small muted" }, text);
  return [
    h("h3", null, "Every account on a computer"),
    h(
      "p",
      { class: "secondary" },
      "Run as root or SYSTEM, as deployment tools do. Each account that uses a coding tool joins as its own machine, like “LAPTOP (alice)”, including accounts added later.",
    ),
    label("Linux (as root):"),
    command(`curl -fsSL ${base}/install.sh | sudo env ${sh} sh`),
    label("Windows (as SYSTEM, such as from Intune or Group Policy):"),
    command(`${ps}; irm ${base}/install.ps1 | iex`),
    label("Windows (in an administrator's elevated PowerShell):"),
    command(`${ps}; $env:CCUNIFIED_ALL_USERS='1'; irm ${base}/install.ps1 | iex`),
    h("h3", null, "One account"),
    h("p", { class: "secondary" }, "Run as the person whose usage it uploads."),
    label("Linux:"),
    command(`curl -fsSL ${base}/install.sh | ${sh} sh`),
    label("Windows (PowerShell):"),
    command(`${ps}; irm ${base}/install.ps1 | iex`),
  ];
}

/** The "Add many machines" card: enrollment keys, and making new ones. */
export function enrollmentCard(
  me: Me,
  repo: string,
  departments: Department[],
): { element: HTMLElement; load: () => Promise<void> } {
  const admin = isAdmin(me);
  const list = h("div");
  const element = h(
    "section",
    { class: "card stack", "aria-labelledby": "enroll-title" },
    h(
      "div",
      { class: "card-head" },
      h(
        "div",
        null,
        h("h2", { id: "enroll-title" }, "Add many machines"),
        h(
          "p",
          null,
          "For a script or deployment tool: an enrollment key lets machines ask to join without anyone typing a code. You approve them on the ",
          h("a", { href: "/approve" }, "Approvals page"),
          ", one at a time or all at once.",
        ),
      ),
      h(
        "button",
        { type: "button", class: "primary", onclick: () => void create() },
        "Create an enrollment key",
      ),
    ),
    list,
  );

  async function load() {
    const { keys } = await api<{ keys: EnrollmentKey[] }>("/enrollment-keys");
    if (keys.length === 0) {
      list.replaceChildren(h("p", { class: "muted" }, "No enrollment keys yet."));
      return;
    }
    const now = Date.now();
    list.replaceChildren(
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
              [
                "Name",
                "Department",
                "Owner",
                "Machines",
                "Waiting",
                "Expires",
                "Last used",
                "",
              ].map((t) => h("th", { scope: "col" }, t)),
            ),
          ),
          h(
            "tbody",
            null,
            keys.map((k) => {
              const expired = k.expires_at !== null && k.expires_at <= now;
              const usedUp = k.max_uses !== null && k.uses >= k.max_uses;
              const state = k.revoked_at
                ? "Revoked"
                : expired
                  ? "Expired"
                  : usedUp
                    ? "Used up"
                    : null;
              return h(
                "tr",
                { class: state ? "dim" : undefined },
                h(
                  "th",
                  { scope: "row" },
                  k.name,
                  h(
                    "span",
                    { class: "sub" },
                    state ??
                      `Created ${relativeTime(k.created_at)}${k.created_by ? ` by ${k.created_by}` : ""}`,
                  ),
                ),
                h("td", null, k.department?.name ?? "None"),
                h("td", null, k.owner?.username ?? "Shared"),
                h("td", null, k.max_uses === null ? `${k.uses}` : `${k.uses} of ${k.max_uses}`),
                h(
                  "td",
                  null,
                  k.waiting > 0 ? h("a", { href: "/approve" }, String(k.waiting)) : "0",
                ),
                h(
                  "td",
                  { title: k.expires_at ? dateTime(k.expires_at) : undefined },
                  k.expires_at === null ? "Never" : relativeTime(k.expires_at),
                ),
                h("td", null, relativeTime(k.last_used_at)),
                h(
                  "td",
                  null,
                  k.revoked_at
                    ? null
                    : h(
                        "button",
                        { type: "button", class: "small danger", onclick: () => void revoke(k) },
                        "Revoke",
                      ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }

  async function revoke(k: EnrollmentKey) {
    const ok = await confirmDialog({
      title: `Revoke the key “${k.name}”?`,
      body: [
        h("p", null, "No more machines can ask to join with it."),
        k.waiting > 0
          ? h(
              "p",
              null,
              `The ${k.waiting} machine${k.waiting === 1 ? "" : "s"} still waiting with it ${k.waiting === 1 ? "is" : "are"} denied. Machines already approved keep uploading.`,
            )
          : h("p", null, "Machines already approved keep uploading."),
      ],
      confirm: "Revoke",
      danger: true,
    });
    if (!ok) return;
    await api(`/enrollment-keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
    toast(`Revoked “${k.name}”`);
    await load();
  }

  async function create() {
    const own = admin ? departments : departments.filter((d) => d.my_role === "manager");
    const { users } = await api<{ users: User[] }>("/users");
    const name = h("input", { maxLength: 64, required: true, placeholder: "Engineering laptops" });
    const department = h(
      "select",
      null,
      admin ? h("option", { value: "" }, "No department") : null,
      own.map((d) => h("option", { value: d.id }, d.name)),
    );
    const owner = h("select");
    const fillOwners = () => {
      const keep = owner.value;
      const dep = department.value;
      const people = users.filter(
        (u) => dep === "" || u.role === "admin" || u.departments.some((d) => d.id === dep),
      );
      owner.replaceChildren(
        h("option", { value: "" }, "Nobody: shared machines"),
        ...people.map((u) => h("option", { value: u.id }, u.username)),
      );
      owner.value = people.some((u) => u.id === keep) ? keep : "";
    };
    department.addEventListener("change", fillOwners);
    fillOwners();
    const expires = h(
      "select",
      null,
      EXPIRY.map(([label, days]) =>
        h("option", { value: days === null ? "" : String(days) }, label),
      ),
    );
    expires.value = "30";
    const maxUses = h("input", {
      type: "number",
      min: "1",
      max: "100000",
      step: "1",
      placeholder: "Any number",
      inputMode: "numeric",
    });
    const error = h("p", { class: "field-error", role: "alert" });
    let created: { key: string; name: string } | undefined;
    await openDialog((close) => {
      const form = h(
        "form",
        { class: "stack", novalidate: true },
        h("h2", null, "Create an enrollment key"),
        h("label", null, "Name", h("span", { class: "hint" }, "To tell your keys apart."), name),
        own.length > 0 || !admin
          ? h(
              "label",
              null,
              "Department",
              h("span", { class: "hint" }, "Machines that join with it go here."),
              department,
            )
          : null,
        h(
          "label",
          null,
          "Owner",
          h("span", { class: "hint" }, "Who uses the machines, if it's one person."),
          owner,
        ),
        h("label", null, "Stops working", expires),
        h(
          "label",
          null,
          "Machines it can add",
          h("span", { class: "hint" }, "Leave empty for any number."),
          maxUses,
        ),
        error,
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "primary" }, "Create"),
        ),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        const uses = maxUses.value.trim();
        if (!name.value.trim()) {
          error.textContent = "Give the key a name.";
          name.focus();
          return;
        }
        if (uses && !/^[1-9][0-9]{0,5}$/.test(uses)) {
          error.textContent = "Enter a whole number of machines, or leave it empty.";
          maxUses.focus();
          return;
        }
        try {
          const res = await api<{ key: string }>("/enrollment-keys", {
            method: "POST",
            body: {
              name: name.value.trim(),
              department_id: department.value || null,
              owner_id: owner.value || null,
              expires_in_days: expires.value ? Number(expires.value) : null,
              max_uses: uses ? Number(uses) : null,
            },
          });
          created = { key: res.key, name: name.value.trim() };
          close("ok");
        } catch (e) {
          error.textContent =
            e instanceof ApiError && e.code === "owner_not_in_department"
              ? "The owner needs a role in the department."
              : e instanceof ApiError && e.code === "department_required"
                ? "Choose one of the departments you manage."
                : "Couldn't create the key. Try again.";
        }
      });
      queueMicrotask(() => name.focus());
      return form;
    });
    if (!created) return;
    const { key, name: keyName } = created;
    await load();
    await openDialog(
      (close) => [
        h("h2", null, `Enrollment key “${keyName}”`),
        h(
          "p",
          { class: "secondary" },
          "Copy it now: it isn't shown again. Anyone with it can ask to add machines, which still need your approval.",
        ),
        command(key),
        h(
          "p",
          { class: "secondary" },
          "Run one of these on each machine, or give it to your deployment tool:",
        ),
        ...enrollCommands(repo, key),
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", class: "primary", onclick: () => close() }, "Done"),
        ),
      ],
      { wide: true },
    );
  }

  return { element, load };
}
