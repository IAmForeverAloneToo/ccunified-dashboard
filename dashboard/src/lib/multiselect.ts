// A filter dropdown: a button that opens a list of checkboxes, with "All" at
// the top. Items may have children (a model family and its models): ticking
// the parent selects all of its children, and the parent shows as partly
// ticked when only some are.
//
// Built on the browser's popover feature, like the date picker: it closes on
// Escape or a click elsewhere, and focus returns to the button.
import { h } from "./dom";

export interface Choice {
  id: string;
  label: string;
  /** Shown after the label, dimmed, such as "revoked". */
  note?: string;
  children?: Choice[];
}

/** The selection after ticking (on) or unticking (off) an item; an empty selection means all. */
export function toggle(
  selected: Set<string>,
  choices: Choice[],
  id: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  const parent = choices.find((c) => c.children?.some((k) => k.id === id));
  const item = choices.find((c) => c.id === id);
  const kids = (c: Choice) => (c.children ?? []).map((k) => k.id);
  if (item) {
    next.delete(id);
    for (const k of kids(item)) next.delete(k);
    if (on) next.add(id);
  } else if (parent) {
    if (next.has(parent.id)) {
      // Unticking one model of a ticked family: keep the others.
      next.delete(parent.id);
      for (const k of kids(parent)) if (k !== id) next.add(k);
    } else if (on) {
      next.add(id);
      if (kids(parent).every((k) => next.has(k))) {
        for (const k of kids(parent)) next.delete(k);
        next.add(parent.id);
      }
    } else {
      next.delete(id);
    }
  }
  return next;
}

/** What the button shows: "All", the names of up to two ticked items, or how many are ticked. */
export function describe(selected: Set<string>, choices: Choice[]): string {
  if (selected.size === 0) return "All";
  if (selected.size > 2) return `${selected.size} selected`;
  const all = choices.flatMap((c) => [c, ...(c.children ?? [])]);
  // In list order, so the button reads like the list.
  const names = all.filter((c) => selected.has(c.id)).map((c) => c.label);
  return names.length === selected.size ? names.join(", ") : `${selected.size} selected`;
}

let instances = 0;

export interface MultiSelect {
  element: HTMLElement;
  /** Updates the button after the selection changed elsewhere. */
  refresh(): void;
  destroy(): void;
}

export function multiSelect(opts: {
  /** The filter's name, such as "Machines". */
  label: string;
  /** The first checkbox, such as "All machines". */
  allLabel: string;
  choices: () => Choice[];
  selected: () => Set<string>;
  /** Called on every change; `first` is true for the first change since the list opened. */
  onChange: (next: Set<string>, first: boolean) => void;
}): MultiSelect {
  const id = `ms-${++instances}`;
  const value = h("span", { class: "ms-value" });
  const button = h(
    "button",
    {
      type: "button",
      class: "ms-button",
      id: `${id}-button`,
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-labelledby": `${id}-label ${id}-button`,
    },
    value,
    h("span", { class: "ms-caret", "aria-hidden": "true" }, "▾"),
  );
  const list = h("div", { class: "ms-list" });
  const panel = h("div", {
    class: "ms",
    id,
    popover: "auto",
    role: "dialog",
    "aria-label": `Filter by ${opts.label.toLowerCase()}`,
  });
  panel.append(list);
  document.body.append(panel);
  button.popoverTargetElement = panel;

  const element = h(
    "div",
    { class: "filter" },
    h("span", { class: "filter-label", id: `${id}-label` }, opts.label),
    button,
  );

  let choices: Choice[] = [];
  let changedSinceOpen = false;
  const expanded = new Set<string>();
  const boxes = new Map<string, HTMLInputElement>();
  let allBox: HTMLInputElement | undefined;

  function refresh() {
    const selected = opts.selected();
    value.textContent = describe(selected, opts.choices());
    button.classList.toggle("active", selected.size > 0);
  }

  /** Ticks the boxes to match the selection. */
  function sync() {
    const selected = opts.selected();
    if (allBox) allBox.checked = selected.size === 0;
    for (const c of choices) {
      const box = boxes.get(c.id);
      if (!box) continue;
      const kids = c.children ?? [];
      box.checked = selected.has(c.id);
      box.indeterminate = !box.checked && kids.some((k) => selected.has(k.id));
      for (const k of kids) {
        const kidBox = boxes.get(k.id);
        if (kidBox) kidBox.checked = selected.has(c.id) || selected.has(k.id);
      }
    }
    refresh();
  }

  function change(itemId: string, on: boolean) {
    const next = itemId === "" ? new Set<string>() : toggle(opts.selected(), choices, itemId, on);
    opts.onChange(next, !changedSinceOpen);
    changedSinceOpen = true;
    sync();
  }

  const checkbox = (itemId: string, label: string, note?: string) => {
    const box = h("input", {
      type: "checkbox",
      onchange: (e: Event) => change(itemId, (e.target as HTMLInputElement).checked),
    });
    if (itemId === "") allBox = box;
    else boxes.set(itemId, box);
    return h(
      "label",
      { class: "ms-option" },
      box,
      h("span", null, label),
      note ? h("span", { class: "ms-note" }, note) : null,
    );
  };

  function build() {
    choices = opts.choices();
    boxes.clear();
    const selected = opts.selected();
    list.replaceChildren(
      checkbox("", opts.allLabel),
      h(
        "ul",
        { role: "list" },
        choices.map((c) => {
          const kids = c.children ?? [];
          if (kids.length === 0) return h("li", null, checkbox(c.id, c.label, c.note));
          if (kids.some((k) => selected.has(k.id))) expanded.add(c.id);
          const childList = h(
            "ul",
            {
              role: "list",
              class: "ms-children",
              id: `${id}-${c.id}`,
              hidden: !expanded.has(c.id),
            },
            kids.map((k) => h("li", null, checkbox(k.id, k.label, k.note))),
          );
          const expand = h(
            "button",
            {
              type: "button",
              class: "ms-expand",
              "aria-expanded": String(expanded.has(c.id)),
              "aria-controls": childList.id,
              "aria-label": `${c.label}: show its ${kids.length} model${kids.length === 1 ? "" : "s"}`,
              onclick: () => {
                const open = childList.hidden;
                childList.hidden = !open;
                expand.setAttribute("aria-expanded", String(open));
                if (open) expanded.add(c.id);
                else expanded.delete(c.id);
              },
            },
            h("span", { class: "ms-chevron", "aria-hidden": "true" }, "▸"),
          );
          return h(
            "li",
            null,
            h("div", { class: "ms-parent" }, checkbox(c.id, c.label, c.note), expand),
            childList,
          );
        }),
      ),
    );
    sync();
  }

  function position() {
    const r = button.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8));
    let top = r.bottom + 6;
    if (top + panel.offsetHeight > window.innerHeight - 8 && r.top - panel.offsetHeight - 6 >= 8) {
      top = r.top - panel.offsetHeight - 6;
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  panel.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    changedSinceOpen = false;
    const r = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, r.left)}px`;
    panel.style.top = `${r.bottom + 6}px`;
    build();
  });
  panel.addEventListener("toggle", (e) => {
    const open = (e as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      position();
      requestAnimationFrame(position);
      (
        panel.querySelector<HTMLInputElement>("input:checked") ??
        panel.querySelector<HTMLInputElement>("input")
      )?.focus();
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
    } else {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (!document.activeElement || document.activeElement === document.body) button.focus();
    }
  });

  refresh();
  return {
    element,
    refresh,
    destroy() {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (panel.matches(":popover-open")) panel.hidePopover();
      panel.remove();
    },
  };
}
