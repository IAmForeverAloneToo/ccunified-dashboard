import { api, type SettingsResponse } from "../lib/api";
import { confirmDialog, fill, h, toast } from "../lib/dom";
import { dateTime, relativeTime } from "../lib/format";
import type { PageContext } from "../main";
import { pricesCard } from "./prices";

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

  // Whether there's a newer release, and when GitHub was last asked.
  const updateStatus = h("div", { class: "stack", role: "status" });
  const checkButton = h("button", { type: "button", class: "small" }, "Check for updates");
  function paintUpdates(s: SettingsResponse) {
    const newer = s.latest_version !== null && s.latest_version !== s.server_version;
    const when = (verb: string) =>
      s.latest_checked_at === null
        ? null
        : h(
            "p",
            { class: "small muted", title: dateTime(s.latest_checked_at) },
            `${verb} ${relativeTime(s.latest_checked_at)}.`,
          );
    fill(
      updateStatus,
      newer
        ? h(
            "div",
            { class: "banner info" },
            h("span", { class: "icon", "aria-hidden": "true" }, "●"),
            h(
              "span",
              null,
              `Version ${s.latest_version} is available. To update the dashboard, run `,
              h("code", null, "ccunified update"),
              " on one of your machines, then ",
              h("code", null, "ccunified server update"),
              " on that machine. Machines that aren't up to date yet are marked on the Machines page.",
            ),
          )
        : s.latest_check_error !== null
          ? h(
              "div",
              { class: "banner warning" },
              h("span", { class: "icon", "aria-hidden": "true" }, "▲"),
              h("span", null, `Couldn't check for updates: ${s.latest_check_error}.`),
            )
          : s.latest_checked_at !== null
            ? h("p", { class: "secondary" }, "It's up to date.")
            : h("p", { class: "secondary" }, "It hasn't checked for updates yet."),
      s.latest_check_error === null
        ? when("Last checked")
        : newer
          ? when(`Couldn't check for updates (${s.latest_check_error}). Last tried`)
          : when("Last tried"),
    );
  }
  paintUpdates(settings);
  // aria-disabled rather than disabled: a disabled button loses keyboard focus.
  let checking = false;
  checkButton.addEventListener("click", async () => {
    if (checking) return;
    checking = true;
    checkButton.setAttribute("aria-disabled", "true");
    checkButton.textContent = "Checking…";
    try {
      paintUpdates(await api<SettingsResponse>("/settings/check-updates", { method: "POST" }));
    } catch {
      toast("Couldn't reach the dashboard. Try again.");
    } finally {
      checking = false;
      checkButton.removeAttribute("aria-disabled");
      checkButton.textContent = "Check for updates";
    }
  });

  const prices = await pricesCard(isAdmin);
  ctx.main.append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Settings"))),
    h(
      "section",
      { class: "card stack", "aria-labelledby": "tz-title" },
      h("h2", { id: "tz-title" }, "Days"),
      form,
    ),
    prices,
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
      updateStatus,
      h("div", { class: "row" }, checkButton),
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
