import {
  ApiError,
  api,
  getCached,
  type Machine,
  type MachinesResponse,
  type SettingsResponse,
  type Summary,
} from "../lib/api";
import { type Child, confirmDialog, h, openDialog, toast } from "../lib/dom";
import { compactNumber, dateTime, OS_LABEL, relativeTime } from "../lib/format";
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

export function addMachineCard(repo: string, isAdmin: boolean): HTMLElement {
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
      isAdmin
        ? [h("a", { href: "/approve" }, "Enter it on the Approvals page"), " within 10 minutes."]
        : "Ask an admin of this dashboard to approve it within 10 minutes.",
    ),
  );
}

export async function machinesPage(ctx: PageContext) {
  const isAdmin = ctx.me.role === "admin";
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
        h("p", null, "Every machine that uploads its Claude Code usage to this dashboard."),
      ),
    ),
    list,
    addSlot,
  );

  async function load() {
    const [m, settings, summary] = await Promise.all([
      api<MachinesResponse>("/machines"),
      api<SettingsResponse>("/settings"),
      getCached<Summary>("/summary?days=30"),
    ]);
    const tokens30 = new Map<string, number>();
    for (const r of summary.by_day_machine) {
      const t = r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
      tokens30.set(r.machine_id, (tokens30.get(r.machine_id) ?? 0) + t);
    }
    const colors = machineSeries(m.machines);
    addSlot.replaceChildren(addMachineCard(settings.source_repo, isAdmin));

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
          "Follow the steps below to add one.",
        ),
      );
      return;
    }

    const rows: Child[] = m.machines.map((machine) => {
      const actions =
        isAdmin && machine.revoked_at === null
          ? h(
              "div",
              { class: "row" },
              h(
                "button",
                { type: "button", class: "small", onclick: () => rename(machine) },
                "Rename",
              ),
              h(
                "button",
                { type: "button", class: "small danger", onclick: () => revoke(machine) },
                "Revoke",
              ),
            )
          : null;
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
        ),
        h("td", null, statusBadge(machine)),
        h("td", { title: dateTime(machine.last_seen_at) }, relativeTime(machine.last_seen_at)),
        h("td", null, `${OS_LABEL[machine.os] ?? machine.os} (${machine.arch})`),
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
        h("td", { class: "num" }, `${machine.sync_interval_minutes} min`),
        h("td", { class: "num" }, compactNumber(tokens30.get(machine.id) ?? 0)),
        isAdmin ? h("td", null, actions) : null,
      );
    });

    list.replaceChildren(
      header,
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
              h("th", { scope: "col" }, "Name"),
              h("th", { scope: "col" }, "Status"),
              h("th", { scope: "col" }, "Last upload"),
              h("th", { scope: "col" }, "System"),
              h("th", { scope: "col" }, "Version"),
              h("th", { scope: "col", class: "num" }, "Sync every"),
              h("th", { scope: "col", class: "num" }, "Tokens (30 days)"),
              isAdmin
                ? h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions"))
                : null,
            ),
          ),
          h("tbody", null, rows),
        ),
      ),
    );
  }

  async function rename(machine: Machine) {
    const input = h("input", { value: machine.name, maxLength: 64, required: true });
    const error = h("p", { class: "field-error", role: "alert" });
    await openDialog((close) => {
      const form = h(
        "form",
        { class: "stack", novalidate: true },
        h("h2", null, "Rename machine"),
        h("label", null, "Name", input),
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
        try {
          await api(`/machines/${encodeURIComponent(machine.id)}`, {
            method: "PATCH",
            body: { name: input.value },
          });
          close("ok");
          toast("Machine renamed");
          await load();
        } catch (e) {
          error.textContent =
            e instanceof ApiError && e.code === "name_taken"
              ? "Another machine already has that name."
              : "Use 1–64 characters.";
        }
      });
      queueMicrotask(() => input.select());
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
    await api(`/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE" });
    toast(`${machine.name} revoked`);
    await load();
  }

  await load();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void load().catch(() => undefined);
  }, 60_000);
  return () => window.clearInterval(timer);
}
