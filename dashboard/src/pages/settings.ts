import { api, type SettingsResponse } from "../lib/api";
import { confirmDialog, h, toast } from "../lib/dom";
import type { PageContext } from "../main";

function timezones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones;
}

export async function settingsPage(ctx: PageContext) {
  const isAdmin = ctx.me.role === "admin";
  const settings = await api<SettingsResponse>("/settings");

  const select = h(
    "select",
    { disabled: !isAdmin, "aria-describedby": "tz-hint" },
    timezones(settings.timezone).map((tz) =>
      h("option", { value: tz, selected: tz === settings.timezone }, tz.replaceAll("_", " ")),
    ),
  );
  const save = h("button", { type: "submit", class: "primary", disabled: true }, "Save");
  select.addEventListener("change", () => {
    save.disabled = select.value === settings.timezone;
  });
  const form = h(
    "form",
    { class: "form" },
    h(
      "label",
      null,
      "Time zone",
      h(
        "span",
        { class: "hint", id: "tz-hint" },
        "Decides where each day starts and ends on the dashboard. Every machine uses it.",
      ),
      select,
    ),
    isAdmin
      ? h("div", { class: "row" }, save)
      : h("p", { class: "muted small" }, "Only admins can change this."),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ok = await confirmDialog({
      title: `Switch to ${select.value}?`,
      body: "Each machine re-uploads the history it still has in the new time zone on its next sync. Older days, whose logs are gone, keep their old dates.",
      confirm: "Switch time zone",
    });
    if (!ok) return;
    await api("/settings", { method: "PATCH", body: { timezone: select.value } });
    settings.timezone = select.value;
    save.disabled = true;
    toast("Time zone changed");
  });

  const upToDate =
    settings.latest_version === null || settings.latest_version === settings.server_version;
  ctx.main.append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Settings"))),
    h(
      "section",
      { class: "card stack", "aria-labelledby": "tz-title" },
      h("h2", { id: "tz-title" }, "Days"),
      form,
    ),
    h(
      "section",
      { class: "card stack", "aria-labelledby": "ver-title" },
      h("h2", { id: "ver-title" }, "Version"),
      h(
        "p",
        null,
        "This dashboard runs ccunified ",
        h("strong", null, settings.server_version),
        ".",
      ),
      upToDate
        ? h("p", { class: "secondary" }, "It's up to date.")
        : h(
            "div",
            { class: "banner info" },
            h("span", { class: "icon", "aria-hidden": "true" }, "●"),
            h(
              "span",
              null,
              `Version ${settings.latest_version} is available. Update the dashboard by running `,
              h("code", null, "ccunified server update"),
              " on any of your machines, then ",
              h("code", null, "ccunified update"),
              " on each machine.",
            ),
          ),
      h(
        "p",
        { class: "small muted" },
        "Source and releases: ",
        h(
          "a",
          {
            href: `https://github.com/${settings.source_repo}`,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          `github.com/${settings.source_repo}`,
        ),
      ),
    ),
  );
  return undefined;
}
