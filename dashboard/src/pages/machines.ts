import { isAdmin, managesSomething } from "../lib/access";
import {
  ApiError,
  api,
  type Department,
  getCached,
  type Machine,
  type MachinesResponse,
  type Summary,
  type User,
} from "../lib/api";
import { type Child, confirmDialog, fill, h, openDialog, toast } from "../lib/dom";
import { compactNumber, dateTime, OS_LABEL, relativeTime } from "../lib/format";
import { toolList } from "../lib/tools";
import type { PageContext } from "../main";
import { machineSeries } from "./overview";

const STATUS: Record<Machine["status"], string> = {
  ok: "Reporting",
  late: "Late",
  never: "Waiting for first upload",
  revoked: "Revoked",
};

export function statusBadge(m: Machine): HTMLElement {
  const detail =
    m.status === "late"
      ? `Last upload ${relativeTime(m.last_seen_at)}; expected every ${m.sync_interval_minutes} minutes`
      : m.status === "ok"
        ? `Last upload ${relativeTime(m.last_seen_at)}`
        : STATUS[m.status];
  return h(
    "span",
    { class: `status ${m.status}`, title: detail },
    h("span", { class: "dot", "aria-hidden": "true" }),
    STATUS[m.status],
  );
}

function copyButton(text: string): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: "small",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("Copied");
        } catch {
          toast("Couldn't copy. Select the text and copy it yourself.");
        }
      },
    },
    "Copy",
  );
}

function command(text: string): HTMLElement {
  return h("div", { class: "command" }, h("pre", null, h("code", null, text)), copyButton(text));
}

export function addMachineCard(repo: string, canApprove: boolean): HTMLElement {
  const base = `https://github.com/${repo}/releases/latest/download`;
  return h(
    "section",
    { class: "card stack", "aria-labelledby": "add-title" },
    h("h2", { id: "add-title" }, "Add a machine"),
    h("p", { class: "secondary" }, "1. On the new machine, run the installer for its system:"),
    h("p", { class: "small muted" }, "Windows (PowerShell):"),
    command(`irm ${base}/install.ps1 | iex`),
    h("p", { class: "small muted" }, "Linux:"),
    command(`curl -fsSL ${base}/install.sh | sh`),
    h(
      "p",
      { class: "secondary" },
      "2. In the setup that starts, choose ",
      h("strong", null, "Join an existing dashboard"),
      " and enter this address:",
    ),
    command(location.origin),
    h(
      "p",
      { class: "secondary" },
      "3. The machine shows a code like ",
      h("code", null, "K7QX-82MD"),
      ". ",
      canApprove
        ? [h("a", { href: "/approve" }, "Enter it on the Approvals page"), " within 10 minutes."]
        : "Ask an admin or your department's manager to approve it within 10 minutes.",
    ),
  );
}

const PAGE_SIZE = 50;

type SortKey = "name" | "department" | "owner" | "status" | "seen" | "tokens";

export async function machinesPage(ctx: PageContext) {
  const admin = isAdmin(ctx.me);
  const list = h("section", { class: "card", "aria-labelledby": "machines-title" });
  const addSlot = h("div");
  ctx.main.append(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Machines"),
        h(
          "p",
          null,
          admin || ctx.me.role === "viewer"
            ? "Every machine that uploads its usage to this dashboard."
            : "The machines you can see: your departments' and your own.",
        ),
      ),
    ),
    list,
    addSlot,
  );

  // What the list shows: a search, a department, a sort and a page.
  const view = { search: "", department: "*", sort: "name" as SortKey, desc: false, page: 0 };
  let data:
    | {
        m: MachinesResponse;
        tokens30: Map<string, number>;
        tools: string[];
        departments: Department[];
      }
    | undefined;

  const search = h("input", {
    type: "search",
    placeholder: "Search by name, owner, department or system",
    "aria-label": "Search machines",
  });
  search.addEventListener("input", () => {
    view.search = search.value;
    view.page = 0;
    draw();
  });
  const departmentFilter = h("select", { "aria-label": "Department" });
  departmentFilter.addEventListener("change", () => {
    view.department = departmentFilter.value;
    view.page = 0;
    draw();
  });

  async function load() {
    const [m, summary, deps] = await Promise.all([
      api<MachinesResponse>("/machines"),
      getCached<Summary>("/summary?days=30"),
      api<{ departments: Department[] }>("/departments"),
    ]);
    const tokens30 = new Map<string, number>();
    for (const r of summary.by_day_machine) {
      const t = r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
      tokens30.set(r.machine_id, (tokens30.get(r.machine_id) ?? 0) + t);
    }
    // Removed machines whose usage was kept only count in the Overview.
    m.machines = m.machines.filter((x) => x.removed_at === null);
    data = { m, tokens30, tools: summary.tools, departments: deps.departments };
    addSlot.replaceChildren(addMachineCard(m.source_repo, managesSomething(ctx.me)));
    draw();
  }

  const STATUS_ORDER: Record<Machine["status"], number> = { late: 0, never: 1, ok: 2, revoked: 3 };
  const sortValue = (m: Machine, key: SortKey): string | number => {
    if (key === "name") return m.name.toLowerCase();
    if (key === "department") return m.department?.name.toLowerCase() ?? "\uffff";
    if (key === "owner") return m.owner?.username.toLowerCase() ?? "\uffff";
    if (key === "status") return STATUS_ORDER[m.status];
    if (key === "seen") return m.last_seen_at ?? 0;
    return data?.tokens30.get(m.id) ?? 0;
  };

  function draw() {
    if (!data) return;
    const { m, tokens30, tools } = data;
    const colors = machineSeries(m.machines);
    // The Tools column appears once machines report more than one tool.
    const showTools = new Set(m.machines.flatMap((x) => x.tools)).size > 1;
    // Department and owner columns, once there are departments or owners.
    const showAccess = data.departments.length > 0 || m.machines.some((x) => x.owner !== null);
    const canManageAny = m.machines.some((x) => x.can_manage);

    const header = h(
      "div",
      { class: "card-head" },
      h(
        "div",
        null,
        h(
          "h2",
          { id: "machines-title" },
          `${m.machines.filter((x) => x.revoked_at === null).length} active`,
        ),
        m.latest_version ? h("p", null, `Latest ccunified version: ${m.latest_version}`) : null,
      ),
    );

    if (m.machines.length === 0) {
      list.replaceChildren(
        header,
        h(
          "div",
          { class: "empty" },
          h("strong", null, "No machines yet"),
          admin || ctx.me.role === "viewer"
            ? "Follow the steps below to add one."
            : "None of your departments' machines, or machines you own, have joined yet.",
        ),
      );
      return;
    }

    // The department filter offers the departments the list has.
    const inList = new Map<string, string>();
    for (const x of m.machines) if (x.department) inList.set(x.department.id, x.department.name);
    const options: [string, string][] = [
      ["*", "All departments"],
      ...[...inList].sort((a, b) => a[1].localeCompare(b[1])),
      ...(m.machines.some((x) => !x.department) ? [["", "No department"] as [string, string]] : []),
    ];
    if (!options.some(([v]) => v === view.department)) view.department = "*";
    departmentFilter.replaceChildren(
      ...options.map(([value, label]) => h("option", { value }, label)),
    );
    departmentFilter.value = view.department;

    const needle = view.search.trim().toLowerCase();
    const shown = m.machines
      .filter((x) => view.department === "*" || (x.department?.id ?? "") === view.department)
      .filter(
        (x) =>
          !needle ||
          [x.name, x.owner?.username ?? "", x.department?.name ?? "", OS_LABEL[x.os] ?? x.os]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => {
        const va = sortValue(a, view.sort);
        const vb = sortValue(b, view.sort);
        const cmp = va < vb ? -1 : va > vb ? 1 : a.name.localeCompare(b.name);
        return view.desc ? -cmp : cmp;
      });
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    view.page = Math.min(view.page, pages - 1);
    const page = shown.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);

    const sortHeader = (key: SortKey, label: string, num = false) =>
      h(
        "th",
        {
          scope: "col",
          class: num ? "num" : undefined,
          "aria-sort": view.sort === key ? (view.desc ? "descending" : "ascending") : undefined,
        },
        h(
          "button",
          {
            type: "button",
            class: "sort",
            onclick: () => {
              view.desc = view.sort === key ? !view.desc : key === "tokens" || key === "seen";
              view.sort = key;
              draw();
            },
          },
          label,
          h(
            "span",
            { class: "sort-arrow", "aria-hidden": "true" },
            view.sort === key ? (view.desc ? "▼" : "▲") : "",
          ),
        ),
      );

    const rows: Child[] = page.map((machine) => {
      const button = (label: string, onclick: () => void, danger = false) =>
        h("button", { type: "button", class: danger ? "small danger" : "small", onclick }, label);
      const actions = !machine.can_manage
        ? null
        : machine.revoked_at === null
          ? h(
              "div",
              { class: "row nowrap" },
              button("Edit", () => edit(machine)),
              button("Revoke", () => revoke(machine), true),
            )
          : h(
              "div",
              { class: "row nowrap" },
              button("Remove", () => remove(machine), true),
            );
      return h(
        "tr",
        { class: machine.revoked_at !== null ? "dim" : undefined },
        h(
          "th",
          { scope: "row" },
          h(
            "span",
            { class: "name-cell" },
            h("span", { class: `swatch ${colors.get(machine.id)?.colorClass ?? "s-other"}` }),
            machine.name,
          ),
          h("span", { class: "sub" }, `${OS_LABEL[machine.os] ?? machine.os} (${machine.arch})`),
        ),
        showAccess
          ? h("td", null, machine.department?.name ?? h("span", { class: "muted" }, "None"))
          : null,
        showAccess
          ? h("td", null, machine.owner?.username ?? h("span", { class: "muted" }, "Shared"))
          : null,
        h("td", null, statusBadge(machine)),
        h(
          "td",
          { title: dateTime(machine.last_seen_at) },
          relativeTime(machine.last_seen_at),
          h("span", { class: "sub" }, `every ${machine.sync_interval_minutes} min`),
        ),
        showTools ? h("td", { class: "wrap" }, toolList(machine.tools, tools) || "—") : null,
        h(
          "td",
          null,
          machine.agent_version,
          machine.update_available && machine.revoked_at === null
            ? [
                " ",
                h(
                  "span",
                  { class: "pill accent", title: "Run `ccunified update` on this machine" },
                  "Update available",
                ),
              ]
            : null,
        ),
        h("td", { class: "num" }, compactNumber(tokens30.get(machine.id) ?? 0)),
        canManageAny ? h("td", null, actions) : null,
      );
    });

    const pager =
      shown.length > PAGE_SIZE
        ? h(
            "div",
            { class: "pager" },
            h(
              "span",
              { class: "muted small", role: "status" },
              `${view.page * PAGE_SIZE + 1}–${view.page * PAGE_SIZE + page.length} of ${shown.length}`,
            ),
            h(
              "button",
              {
                type: "button",
                class: "small",
                disabled: view.page === 0,
                onclick: () => {
                  view.page -= 1;
                  draw();
                },
              },
              "Previous",
            ),
            h(
              "button",
              {
                type: "button",
                class: "small",
                disabled: view.page >= pages - 1,
                onclick: () => {
                  view.page += 1;
                  draw();
                },
              },
              "Next",
            ),
          )
        : null;

    fill(
      list,
      header,
      h(
        "div",
        { class: "list-tools" },
        search,
        options.length > 2 ? h("label", { class: "inline" }, "Department", departmentFilter) : null,
      ),
      shown.length === 0
        ? h("p", { class: "muted" }, "No machines match.")
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
                  sortHeader("name", "Name"),
                  showAccess ? sortHeader("department", "Department") : null,
                  showAccess ? sortHeader("owner", "Owner") : null,
                  sortHeader("status", "Status"),
                  sortHeader("seen", "Last upload"),
                  showTools ? h("th", { scope: "col" }, "Tools") : null,
                  h("th", { scope: "col" }, "Version"),
                  sortHeader("tokens", "Tokens (30 days)", true),
                  canManageAny
                    ? h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions"))
                    : null,
                ),
              ),
              h("tbody", null, rows),
            ),
          ),
      pager,
    );
  }

  /** Rename, move to another department, or pick an owner. */
  async function edit(machine: Machine) {
    const departments = (data?.departments ?? []).filter((d) => admin || d.my_role === "manager");
    const { users } = await api<{ users: User[] }>("/users");
    const name = h("input", { value: machine.name, maxLength: 64, required: true });
    const department = h(
      "select",
      null,
      admin ? h("option", { value: "" }, "No department") : null,
      departments.map((d) => h("option", { value: d.id }, d.name)),
    );
    department.value = machine.department?.id ?? "";
    const owner = h("select");
    const fillOwners = () => {
      const keep = owner.value || machine.owner?.id || "";
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
    };
    department.addEventListener("change", fillOwners);
    fillOwners();
    const error = h("p", { class: "field-error", role: "alert" });
    await openDialog((close) => {
      const form = h(
        "form",
        { class: "stack", novalidate: true },
        h("h2", null, `Edit ${machine.name}`),
        h("label", null, "Name", name),
        h("label", null, "Department", department),
        h(
          "label",
          null,
          "Owner",
          h(
            "span",
            { class: "hint" },
            "Someone with a role in its department, or an admin. Owners always see their machines.",
          ),
          owner,
        ),
        error,
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "primary" }, "Save"),
        ),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body: Record<string, string | null> = {};
        if (name.value.trim() !== machine.name) body.name = name.value.trim();
        if (department.value !== (machine.department?.id ?? "")) {
          body.department_id = department.value || null;
        }
        if (owner.value !== (machine.owner?.id ?? "")) body.owner_id = owner.value || null;
        if (Object.keys(body).length === 0) {
          close();
          return;
        }
        try {
          await api(`/machines/${encodeURIComponent(machine.id)}`, { method: "PATCH", body });
          close("ok");
          toast(`Saved ${name.value.trim()}`);
          await load();
        } catch (e) {
          error.textContent =
            e instanceof ApiError && e.code === "name_taken"
              ? "Another machine already has that name."
              : e instanceof ApiError && e.code === "owner_not_in_department"
                ? "The owner needs a role in the machine's department."
                : "Couldn't save. Use a name of 1–64 characters.";
        }
      });
      queueMicrotask(() => name.select());
      return form;
    });
  }

  async function revoke(machine: Machine) {
    const ok = await confirmDialog({
      title: `Revoke ${machine.name}?`,
      body: [
        h(
          "p",
          null,
          "This machine's upload key stops working immediately. Its past usage stays on the dashboard.",
        ),
        h(
          "p",
          null,
          "To add it again later, run ",
          h("code", null, "ccunified setup"),
          " on it and approve the new code.",
        ),
      ],
      confirm: "Revoke",
      danger: true,
    });
    if (!ok) return;
    await api(`/machines/${encodeURIComponent(machine.id)}/revoke`, { method: "POST" });
    toast(`${machine.name} revoked`);
    await load();
  }

  async function remove(machine: Machine) {
    const choice = (value: "keep" | "delete", label: string, hint: string) =>
      h(
        "label",
        { class: "choice" },
        h("input", { type: "radio", name: "usage", value, checked: value === "keep" }),
        h("span", { class: "choice-text" }, label, h("span", { class: "hint" }, hint)),
      );
    const answer = await openDialog((close) => {
      const form = h(
        "form",
        { class: "stack" },
        h("h2", null, `Remove ${machine.name}?`),
        h(
          "p",
          { class: "secondary" },
          "It leaves the Machines page and the machine filter for good. This can't be undone.",
        ),
        h(
          "fieldset",
          { class: "choices" },
          h("legend", null, "Its usage"),
          choice(
            "keep",
            "Keep it in the totals",
            "Its tokens and costs still count, shown as “Removed machines”.",
          ),
          choice(
            "delete",
            "Delete it",
            "Its tokens and costs are deleted, and past totals drop by what it used.",
          ),
        ),
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { type: "button", onclick: () => close() }, "Cancel"),
          h("button", { type: "submit", class: "danger" }, "Remove"),
        ),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        close(new FormData(form).get("usage") === "delete" ? "delete" : "keep");
      });
      return form;
    });
    if (answer !== "keep" && answer !== "delete") return;
    await api(`/machines/${encodeURIComponent(machine.id)}?usage=${answer}`, { method: "DELETE" });
    toast(
      answer === "keep"
        ? `${machine.name} removed; its usage was kept`
        : `${machine.name} and its usage removed`,
    );
    await load();
  }

  await load();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void load().catch(() => undefined);
  }, 60_000);
  return () => window.clearInterval(timer);
}
