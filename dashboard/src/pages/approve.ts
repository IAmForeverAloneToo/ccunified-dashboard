import { isAdmin } from "../lib/access";
import { ApiError, api, type Department, type PairingRequest, type User } from "../lib/api";
import { fill, h, toast } from "../lib/dom";
import { OS_LABEL, relativeTime } from "../lib/format";
import type { PageContext } from "../main";

/** Formats typing into "XXXX-XXXX" (letters and digits, upper case). */
function formatCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export async function approvePage(ctx: PageContext) {
  const admin = isAdmin(ctx.me);
  // Admins approve into any department, or none; managers into theirs.
  const [{ departments: all }, { users }] = await Promise.all([
    api<{ departments: Department[] }>("/departments"),
    api<{ users: User[] }>("/users"),
  ]);
  const departments = admin ? all : all.filter((d) => d.my_role === "manager");
  const department = h(
    "select",
    { "aria-describedby": "department-hint" },
    admin ? h("option", { value: "" }, "No department") : null,
    departments.map((d) => h("option", { value: d.id }, d.name)),
  );
  const owner = h("select", { "aria-describedby": "owner-hint" });
  /** The owners to offer: people with a role in the department, or anyone (admins, no department). */
  function fillOwners() {
    const keep = owner.value;
    const dep = department.value;
    // People with a role in the department, and admins (who can own any machine).
    const people = users.filter(
      (u) => dep === "" || u.role === "admin" || u.departments.some((d) => d.id === dep),
    );
    owner.replaceChildren(
      h("option", { value: "" }, "Nobody: a shared machine"),
      ...people.map((u) => h("option", { value: u.id }, u.username)),
    );
    owner.value = people.some((u) => u.id === keep) ? keep : "";
  }
  department.addEventListener("change", fillOwners);
  fillOwners();
  const code = h("input", {
    class: "code-input",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "XXXX-XXXX",
    maxLength: 9,
    "aria-describedby": "code-hint",
  });
  code.addEventListener("input", () => {
    code.value = formatCode(code.value);
  });
  const name = h("input", { maxLength: 64, placeholder: "Keep the machine's own name" });
  const nameField = h(
    "label",
    null,
    "Name on the dashboard (optional)",
    h(
      "span",
      { class: "hint", id: "name-hint" },
      "Leave empty to use the name the machine suggested.",
    ),
    name,
  );
  const message = h("p", { class: "field-error", role: "alert" });
  const approve = h("button", { type: "submit", class: "primary" }, "Approve");
  const deny = h("button", { type: "button", class: "danger" }, "Deny");
  const pendingCard = h("section", { class: "card", "aria-labelledby": "pending-title" });

  const form = h(
    "form",
    { class: "form", novalidate: true },
    h(
      "label",
      null,
      "Code shown on the machine",
      h(
        "span",
        { class: "hint", id: "code-hint" },
        "Approve only codes you can see on your own machine's screen.",
      ),
      code,
    ),
    nameField,
    departments.length > 0 || !admin
      ? h(
          "label",
          null,
          "Department",
          h(
            "span",
            { class: "hint", id: "department-hint" },
            admin ? "Its managers and viewers will see it." : "One of the departments you manage.",
          ),
          department,
        )
      : null,
    h(
      "label",
      null,
      "Owner",
      h(
        "span",
        { class: "hint", id: "owner-hint" },
        "Who uses it. Owners always see their machines; members see only theirs.",
      ),
      owner,
    ),
    message,
    h("div", { class: "row" }, approve, deny),
  );

  async function decide(action: "approve" | "deny") {
    message.textContent = "";
    if (formatCode(code.value).length !== 9) {
      message.textContent = "Enter the 8-character code, like K7QX-82MD.";
      code.focus();
      return;
    }
    const body: Record<string, string | null> = { user_code: code.value };
    if (action === "approve") {
      if (name.value.trim()) body.name = name.value.trim();
      body.department_id = department.value || null;
      body.owner_id = owner.value || null;
    }
    approve.disabled = deny.disabled = true;
    try {
      const res = await api<{ name?: string }>(`/pairing/${action}`, { method: "POST", body });
      toast(
        action === "approve"
          ? `Approved ${res.name}. It will start uploading in a moment.`
          : "Request denied",
      );
      form.reset();
      fillOwners();
      await loadPending();
      ctx.refreshApprovals();
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") {
        message.textContent =
          "No machine is waiting with that code. Codes expire after 10 minutes.";
      } else if (e instanceof ApiError && e.code === "name_taken") {
        message.textContent = `Another machine is already called "${e.body.name}". Enter a different name above.`;
        name.focus();
      } else if (e instanceof ApiError && e.code === "invalid_code") {
        message.textContent = "That doesn't look like a valid code.";
      } else if (e instanceof ApiError && e.code === "department_required") {
        message.textContent = "Choose one of the departments you manage.";
      } else if (e instanceof ApiError && e.code === "owner_not_in_department") {
        message.textContent = "The owner needs a role in the machine's department.";
      } else {
        message.textContent = "Something went wrong. Try again.";
      }
    } finally {
      approve.disabled = deny.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void decide("approve");
  });
  deny.addEventListener("click", () => void decide("deny"));

  // Machines that enrolled with a key: approved from this list.
  const enrolledCard = h("section", { class: "card stack", "aria-labelledby": "enrolled-title" });
  const selected = new Set<string>();
  let enrolled: PairingRequest[] = [];

  async function decideMany(ids: string[], approve: boolean) {
    if (ids.length === 0) return;
    const res = await api<{ decided: number }>("/pairing/decide", {
      method: "POST",
      body: { ids, approve },
    });
    const n = res.decided;
    toast(
      approve
        ? `Approved ${n} machine${n === 1 ? "" : "s"}. ${n === 1 ? "It starts" : "They start"} uploading at ${n === 1 ? "its" : "their"} next sync.`
        : `Denied ${n} machine${n === 1 ? "" : "s"}`,
    );
    for (const id of ids) selected.delete(id);
    await loadPending();
    ctx.refreshApprovals();
  }

  function drawEnrolled() {
    for (const id of [...selected]) if (!enrolled.some((r) => r.id === id)) selected.delete(id);
    const count = selected.size;
    const all = h("input", {
      type: "checkbox",
      "aria-label": "Select every machine",
      checked: enrolled.length > 0 && count === enrolled.length,
      onchange: () => {
        if (all.checked) for (const r of enrolled) selected.add(r.id);
        else selected.clear();
        drawEnrolled();
      },
    });
    all.indeterminate = count > 0 && count < enrolled.length;
    const approveButton = h(
      "button",
      {
        type: "button",
        class: "primary",
        disabled: count === 0,
        onclick: () => void decideMany([...selected], true),
      },
      count > 0 ? `Approve ${count}` : "Approve",
    );
    const denyButton = h(
      "button",
      {
        type: "button",
        class: "danger",
        disabled: count === 0,
        onclick: () => void decideMany([...selected], false),
      },
      count > 0 ? `Deny ${count}` : "Deny",
    );
    fill(
      enrolledCard,
      h(
        "div",
        { class: "card-head" },
        h(
          "div",
          null,
          h("h2", { id: "enrolled-title" }, "Joined with an enrollment key"),
          h(
            "p",
            null,
            "These machines asked to join with one of your enrollment keys. Approve them to let them upload; each request waits up to 30 days.",
          ),
        ),
      ),
      enrolled.length === 0
        ? h("p", { class: "muted" }, "No machines are waiting right now.")
        : [
            h("div", { class: "row" }, approveButton, denyButton),
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
                    h("th", { scope: "col", class: "check" }, all),
                    ["Name", "Department", "Owner", "Key", "System", "Asked"].map((t) =>
                      h("th", { scope: "col" }, t),
                    ),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  enrolled.map((r) => {
                    const box = h("input", {
                      type: "checkbox",
                      "aria-label": `Select ${r.machine_name}`,
                      checked: selected.has(r.id),
                      onchange: () => {
                        if (box.checked) selected.add(r.id);
                        else selected.delete(r.id);
                        drawEnrolled();
                      },
                    });
                    return h(
                      "tr",
                      null,
                      h("td", { class: "check" }, box),
                      h("th", { scope: "row" }, r.machine_name),
                      h("td", null, r.department?.name ?? "None"),
                      h("td", null, r.owner?.username ?? "Shared"),
                      h("td", null, r.key?.name ?? ""),
                      h("td", null, `${OS_LABEL[r.os] ?? r.os} (${r.arch}), ${r.agent_version}`),
                      h(
                        "td",
                        { title: `Expires ${relativeTime(r.expires_at)}` },
                        relativeTime(r.created_at),
                      ),
                    );
                  }),
                ),
              ),
            ),
          ],
    );
  }

  async function loadPending() {
    const { requests } = await api<{ requests: PairingRequest[] }>("/pairing");
    enrolled = requests.filter((r) => r.key !== null);
    drawEnrolled();
    if (!admin) return;
    const withCode = requests.filter((r) => r.key === null);
    pendingCard.replaceChildren(
      h(
        "div",
        { class: "card-head" },
        h(
          "div",
          null,
          h("h2", { id: "pending-title" }, "Waiting with a code"),
          h(
            "p",
            null,
            "For reference only. To approve, type the code from the machine's screen above.",
          ),
        ),
      ),
      withCode.length === 0
        ? h("p", { class: "muted" }, "No machines are waiting right now.")
        : h(
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
                  ["Suggested name", "System", "Version", "From address", "Asked", "Expires"].map(
                    (t) => h("th", { scope: "col" }, t),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                withCode.map((r) =>
                  h(
                    "tr",
                    null,
                    h("th", { scope: "row" }, r.machine_name),
                    h("td", null, `${OS_LABEL[r.os] ?? r.os} (${r.arch})`),
                    h("td", null, r.agent_version),
                    h("td", { class: "mono" }, r.client_ip ?? "unknown"),
                    h("td", null, relativeTime(r.created_at)),
                    h("td", null, relativeTime(r.expires_at)),
                  ),
                ),
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
        h("h1", null, "Approve a machine"),
        h(
          "p",
          null,
          "When you run ",
          h("code", null, "ccunified setup"),
          " on a new machine and choose to join this dashboard, it shows a code. Enter it here. Machines that joined with an enrollment key are listed below.",
        ),
      ),
    ),
    h("section", { class: "card" }, form),
    enrolledCard,
  );
  // Only admins see who is waiting with a code; managers approve the code they're given.
  if (admin) ctx.main.append(pendingCard);
  code.focus();
  await loadPending();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadPending().catch(() => undefined);
  }, 5000);
  return () => window.clearInterval(timer);
}
