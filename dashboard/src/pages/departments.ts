import { ApiError, api, type Department } from "../lib/api";
import { confirmDialog, h, openDialog, toast } from "../lib/dom";
import type { PageContext } from "../main";

/** A dialog asking for a department's name; resolves with it, or undefined if cancelled. */
async function askName(title: string, current: string, save: (name: string) => Promise<void>) {
  const input = h("input", { value: current, maxLength: 64, required: true });
  const error = h("p", { class: "field-error", role: "alert" });
  await openDialog((close) => {
    const form = h(
      "form",
      { class: "stack", novalidate: true },
      h("h2", null, title),
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
      if (!input.value.trim()) {
        error.textContent = "Enter a name.";
        return;
      }
      try {
        await save(input.value.trim());
        close("ok");
      } catch (e) {
        error.textContent =
          e instanceof ApiError && e.code === "name_taken"
            ? "Another department already has that name."
            : "Use 1–64 characters.";
      }
    });
    queueMicrotask(() => input.select());
    return form;
  });
}

/** Admins: the departments machines and people belong to. */
export async function departmentsPage(ctx: PageContext) {
  const listCard = h("section", { class: "card", "aria-labelledby": "departments-title" });
  const add = h("button", { type: "button", class: "primary" }, "Add a department…");
  add.addEventListener("click", () =>
    askName("Add a department", "", async (name) => {
      await api("/departments", { method: "POST", body: { name } });
      toast(`Added ${name}`);
      await load();
    }),
  );

  async function load() {
    const { departments } = await api<{ departments: Department[] }>("/departments");
    listCard.replaceChildren(
      h(
        "div",
        { class: "card-head" },
        h(
          "h2",
          { id: "departments-title" },
          `${departments.length} department${departments.length === 1 ? "" : "s"}`,
        ),
      ),
      departments.length === 0
        ? h(
            "div",
            { class: "empty" },
            h("strong", null, "No departments yet"),
            h(
              "span",
              null,
              "Add one, then give people roles in it on the Users page and put machines in it on the Machines page.",
            ),
          )
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
                  h("th", { scope: "col" }, "Name"),
                  h("th", { scope: "col", class: "num" }, "Machines"),
                  h("th", { scope: "col", class: "num" }, "People"),
                  h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")),
                ),
              ),
              h(
                "tbody",
                null,
                departments.map((d) =>
                  h(
                    "tr",
                    null,
                    h("th", { scope: "row" }, d.name),
                    h("td", { class: "num" }, String(d.machines)),
                    h("td", { class: "num" }, String(d.people)),
                    h(
                      "td",
                      null,
                      h(
                        "div",
                        { class: "row" },
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small",
                            onclick: () =>
                              askName(`Rename ${d.name}`, d.name, async (name) => {
                                await api(`/departments/${encodeURIComponent(d.id)}`, {
                                  method: "PATCH",
                                  body: { name },
                                });
                                toast("Department renamed");
                                await load();
                              }),
                          },
                          "Rename",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            class: "small danger",
                            onclick: async () => {
                              const ok = await confirmDialog({
                                title: `Delete ${d.name}?`,
                                body: "Its machines stay, without a department, and keep their owners. Its people lose their roles in it.",
                                confirm: "Delete",
                                danger: true,
                              });
                              if (!ok) return;
                              await api(`/departments/${encodeURIComponent(d.id)}`, {
                                method: "DELETE",
                              }).catch(() => toast("Couldn't delete the department."));
                              await load();
                            },
                          },
                          "Delete",
                        ),
                      ),
                    ),
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
        h("h1", null, "Departments"),
        h(
          "p",
          null,
          "Groups of machines and people. Managers look after a department's machines and people; its viewers see its machines; its members see the machines they own.",
        ),
      ),
      add,
    ),
    listCard,
  );
  await load();
  return undefined;
}
