import { ApiError, api, type PairingRequest } from "../lib/api";
import { h, toast } from "../lib/dom";
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
    const body: Record<string, string> = { user_code: code.value };
    if (action === "approve" && name.value.trim()) body.name = name.value.trim();
    approve.disabled = deny.disabled = true;
    try {
      const res = await api<{ name?: string }>(`/pairing/${action}`, { method: "POST", body });
      toast(
        action === "approve"
          ? `Approved ${res.name}. It will start uploading in a moment.`
          : "Request denied",
      );
      form.reset();
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

  async function loadPending() {
    const { requests } = await api<{ requests: PairingRequest[] }>("/pairing");
    pendingCard.replaceChildren(
      h(
        "div",
        { class: "card-head" },
        h(
          "div",
          null,
          h("h2", { id: "pending-title" }, "Waiting to join"),
          h(
            "p",
            null,
            "For reference only. To approve, type the code from the machine's screen above.",
          ),
        ),
      ),
      requests.length === 0
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
                requests.map((r) =>
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
          " on a new machine and choose to join this dashboard, it shows a code. Enter it here.",
        ),
      ),
    ),
    h("section", { class: "card" }, form),
    pendingCard,
  );
  code.focus();
  await loadPending();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadPending().catch(() => undefined);
  }, 5000);
  return () => window.clearInterval(timer);
}
