// The Settings page's Prices section: how estimated costs are worked out, and
// custom prices per model.
import { ApiError, api, type Price, type PricesResponse, type PricingMode } from "../lib/api";
import { fill, h, segmented, toast } from "../lib/dom";

const MODES: [PricingMode, string][] = [
  ["ccusage", "ccusage (default)"],
  ["lists", "Price lists"],
  ["custom", "Custom"],
];

const MODE_HINT: Record<PricingMode, string> = {
  ccusage: "The cost each machine's ccusage worked out, request by request.",
  lists:
    "Each model maker's price on models.dev, or else on LiteLLM; models in neither keep ccusage's cost. Machines send these prices once a day.",
  custom: "Your prices for the models you fill in; the others are priced as with the price lists.",
};

const FIELDS: [keyof Price, string][] = [
  ["input", "Input"],
  ["output", "Output"],
  ["cache_write", "Cache write"],
  ["cache_read", "Cache read"],
];

type Row = PricesResponse["models"][number];

/** The price a model gets in a mode, and where it comes from (null: ccusage's cost). */
function priceIn(row: Row, mode: PricingMode): { price: Price; from: string } | null {
  if (mode === "ccusage") return null;
  if (mode === "custom" && row.custom) return { price: row.custom, from: "Custom" };
  if (row.models_dev) return { price: row.models_dev, from: `models.dev: ${row.models_dev.entry}` };
  if (row.litellm) return { price: row.litellm, from: `LiteLLM: ${row.litellm.entry}` };
  return null;
}

const dollars = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** The Prices card; admins can change it. */
export async function pricesCard(isAdmin: boolean): Promise<HTMLElement> {
  let data = await api<PricesResponse>("/prices");
  let mode = data.mode;
  const card = h("section", { class: "card stack", "aria-labelledby": "prices-title" });
  const hint = h("p", { class: "hint", id: "pricing-hint" });
  const tableSlot = h("div");
  const error = h("p", { class: "field-error", role: "alert" });
  const save = h("button", { type: "submit", class: "primary" }, "Save");
  /** The custom price inputs, by model. */
  let inputs = new Map<string, Map<keyof Price, HTMLInputElement>>();

  const modes = segmented<PricingMode>("pricing", "Work costs out with", MODES, mode, (v) => {
    mode = v;
    paint();
  });
  if (!isAdmin) {
    for (const radio of modes.querySelectorAll("input")) radio.disabled = true;
  }

  function paint() {
    hint.textContent = MODE_HINT[mode];
    inputs = new Map();
    const editing = isAdmin && mode === "custom";
    if (mode === "ccusage") {
      // No dashboard prices in play.
      fill(tableSlot);
      return;
    }
    if (data.models.length === 0) {
      fill(tableSlot, h("p", { class: "muted" }, "No models have reported usage yet."));
      return;
    }
    fill(
      tableSlot,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h("caption", { class: "visually-hidden" }, "Prices in US dollars per million tokens"),
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "Model"),
              FIELDS.map(([, label]) => h("th", { scope: "col", class: "num" }, label)),
              h("th", { scope: "col" }, "Price used"),
            ),
          ),
          h(
            "tbody",
            null,
            data.models.map((row) => {
              const used = priceIn(row, mode);
              const list = priceIn(row, "lists");
              const cells = FIELDS.map(([key, label]) => {
                if (!editing) {
                  return h("td", { class: "num" }, used ? dollars(used.price[key]) : "—");
                }
                const input = h("input", {
                  type: "number",
                  min: "0",
                  step: "any",
                  inputmode: "decimal",
                  class: "price-input",
                  "aria-label": `${label} price for ${row.model}`,
                  value: row.custom ? String(row.custom[key]) : "",
                  placeholder: list ? String(list.price[key]) : "",
                });
                const forModel = inputs.get(row.model) ?? new Map();
                forModel.set(key, input);
                inputs.set(row.model, forModel);
                return h("td", { class: "num" }, input);
              });
              return h(
                "tr",
                null,
                h("th", { scope: "row" }, row.model),
                cells,
                h(
                  "td",
                  { class: "muted small" },
                  editing
                    ? row.custom
                      ? "Custom"
                      : list
                        ? `Empty: ${list.from}`
                        : "Empty: ccusage's cost"
                    : (used?.from ?? "ccusage's cost"),
                ),
              );
            }),
          ),
        ),
      ),
      h(
        "p",
        { class: "small muted" },
        editing
          ? "US dollars per million tokens. Leave a model's prices empty to use the price lists; the placeholders show them."
          : "US dollars per million tokens.",
      ),
    );
  }

  const form = h(
    "form",
    { class: "stack", novalidate: true },
    h("div", { class: "filters" }, modes),
    hint,
    tableSlot,
    h(
      "p",
      { class: "small muted" },
      "Changes apply to all history. The dashboard keeps daily totals, so with the price lists or custom prices, long-context surcharges and the 1-hour cache-write rate aren't applied; ccusage applies them.",
    ),
    error,
    isAdmin
      ? h("div", { class: "row" }, save)
      : h("p", { class: "muted small" }, "Only admins can change this."),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const custom: Record<string, Price | null> = {};
    if (mode === "custom") {
      for (const [model, fields] of inputs) {
        const values = FIELDS.map(([key]) => fields.get(key)?.value.trim() ?? "");
        const row = data.models.find((m) => m.model === model);
        if (values.every((v) => v === "")) {
          if (row?.custom) custom[model] = null;
          continue;
        }
        const numbers = values.map(Number);
        if (values.some((v) => v === "") || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
          error.textContent = `Fill in all four prices for ${model} (0 or more), or none.`;
          fields.get("input")?.focus();
          return;
        }
        const [input, output, cache_write, cache_read] = numbers as [
          number,
          number,
          number,
          number,
        ];
        custom[model] = { input, output, cache_write, cache_read };
      }
    }
    try {
      await api("/prices", {
        method: "PATCH",
        body: Object.keys(custom).length > 0 ? { mode, custom } : { mode },
      });
      data = await api<PricesResponse>("/prices");
      paint();
      toast("Prices saved");
    } catch (e) {
      error.textContent =
        e instanceof ApiError
          ? "Couldn't save the prices. Check them."
          : "Couldn't save. Try again.";
    }
  });

  paint();
  card.append(
    h("h2", { id: "prices-title" }, "Prices"),
    h(
      "p",
      { class: "secondary" },
      "How the estimated costs on the dashboard are worked out. They're estimates at API prices, not a subscription bill.",
    ),
    form,
  );
  return card;
}
