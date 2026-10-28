// Tiny DOM helpers. Text always goes in as text nodes (never innerHTML), so
// names that come from machines or users can't inject markup.

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown>;

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
  } else if (child instanceof Node) {
    parent.appendChild(child);
  } else {
    parent.appendChild(document.createTextNode(String(child)));
  }
}

function applyProps(el: Element, props: Props | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      el.setAttribute("class", String(value));
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in el && !(el instanceof SVGElement) && !key.includes("-")) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props ?? undefined);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props ?? undefined);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** Replaces an element's contents with the given children (nested lists allowed). */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

let toastTimer: number | undefined;

/** A short message at the bottom of the screen, also announced to screen readers. */
export function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, message);
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3500);
}

/** A labelled radio-button group styled as a segmented control. */
export function segmented<T extends string>(
  name: string,
  label: string,
  options: [T, string][],
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  return h(
    "div",
    { class: "filter" },
    h("span", { class: "filter-label", id: `${name}-label` }, label),
    h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-labelledby": `${name}-label` },
      options.map(([v, text]) =>
        h(
          "label",
          null,
          h("input", {
            type: "radio",
            name,
            value: v,
            checked: v === value,
            onchange: () => onChange(v),
          }),
          h("span", null, text),
        ),
      ),
    ),
  );
}

/** Opens a modal dialog; resolves with the button value or form data on close. */
let dialogCount = 0;

export function openDialog(
  build: (close: (value?: string) => void) => Child,
  opts: { wide?: boolean } = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: opts.wide ? "wide" : undefined });
    let result: string | undefined;
    const close = (value?: string) => {
      result = value;
      dialog.close();
    };
    dialog.append(h("div", { class: "dialog-body" }, build(close)));
    // Named by its heading, for screen readers.
    const title = dialog.querySelector("h2");
    if (title) {
      title.id ||= `dialog-title-${++dialogCount}`;
      dialog.setAttribute("aria-labelledby", title.id);
    }
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks a yes/no question in a dialog. */
export async function confirmDialog(opts: {
  title: string;
  body: Child;
  confirm: string;
  danger?: boolean;
}): Promise<boolean> {
  const answer = await openDialog((close) => [
    h("h2", null, opts.title),
    h("div", { class: "secondary" }, opts.body),
    h(
      "div",
      { class: "dialog-actions" },
      h("button", { type: "button", onclick: () => close() }, "Cancel"),
      h(
        "button",
        { type: "button", class: opts.danger ? "danger" : "primary", onclick: () => close("yes") },
        opts.confirm,
      ),
    ),
  ]);
  return answer === "yes";
}

/** A button that copies text to the clipboard. */
export function copyButton(text: string): HTMLButtonElement {
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

/** A command to run, with a Copy button. */
export function command(text: string): HTMLElement {
  return h("div", { class: "command" }, h("pre", null, h("code", null, text)), copyButton(text));
}
