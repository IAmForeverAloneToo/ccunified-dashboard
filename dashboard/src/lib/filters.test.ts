import { describe, expect, test } from "vitest";
import type { DetailedSummary, SummaryDetail } from "./api";
import {
  allowedMachines,
  allowedModels,
  applyFilters,
  available,
  isFiltered,
  matcher,
  noFilters,
  readFilters,
  writeFilters,
} from "./filters";
import { type Choice, describe as describeSelection, toggle } from "./multiselect";

describe("filters in the address", () => {
  test("survive a round trip and keep the page's other settings", () => {
    const q = new URLSearchParams("range=30&by=tool&machine=old");
    writeFilters(q, {
      departments: ["d1", "none"],
      machines: ["m1", "m2"],
      tools: ["kimi"],
      families: ["opus"],
      models: ["a,b model"],
    });
    expect(q.get("range")).toBe("30");
    expect(q.getAll("machine")).toEqual(["m1", "m2"]);
    expect(q.getAll("department")).toEqual(["d1", "none"]);
    expect(readFilters(new URLSearchParams(q.toString()))).toEqual({
      departments: ["d1", "none"],
      machines: ["m1", "m2"],
      tools: ["kimi"],
      families: ["opus"],
      models: ["a,b model"],
    });
    writeFilters(q, noFilters());
    expect(q.toString()).toBe("range=30&by=tool");
    expect(isFiltered(readFilters(q))).toBe(false);
  });
});

describe("matching", () => {
  test("an empty filter allows everything; filters combine", () => {
    expect(matcher(noFilters())("m", "codex", "gpt-5.5")).toBe(true);
    const ok = matcher({ ...noFilters(), machines: ["m1"], tools: ["claude", "kimi"] });
    expect(ok("m1", "kimi", "k3")).toBe(true);
    expect(ok("m2", "kimi", "k3")).toBe(false);
    expect(ok("m1", "codex", "gpt-5.5")).toBe(false);
  });

  test("a family allows all its models, including ones it hasn't seen yet", () => {
    const ok = matcher({ ...noFilters(), families: ["opus"], models: ["k3"] });
    expect(ok("m", "claude", "claude-opus-5-5")).toBe(true);
    expect(ok("m", "opencode", "anthropic/claude-opus-6-0")).toBe(true);
    expect(ok("m", "kimi", "k3")).toBe(true);
    expect(ok("m", "claude", "claude-sonnet-5-5")).toBe(false);
  });

  test("the models to ask the server about", () => {
    const known = ["claude-opus-5-5", "claude-opus-4-5", "claude-sonnet-5-5", "k3"];
    expect(allowedModels(noFilters(), known)).toBeNull();
    expect(allowedModels({ ...noFilters(), families: ["opus"], models: ["k3"] }, known)).toEqual([
      "claude-opus-5-5",
      "claude-opus-4-5",
      "k3",
    ]);
  });
});

describe("filtering a summary", () => {
  const summary = {
    timezone: "UTC",
    today: "2026-10-02",
    from: "2026-10-01",
    to: "2026-10-02",
    tools: ["claude", "kimi"],
    models: ["claude-opus-5-5", "k3"],
    bucket: "day",
    detail: {
      days: ["2026-10-01", "2026-10-02"],
      machines: ["a", "b"],
      sources: ["claude", "kimi"],
      models: ["claude-opus-5-5", "k3"],
      rows: [
        [0, 0, 0, 0, 10, 1, 0, 100, 1.5],
        [0, 1, 1, 1, 20, 2, 0, 200, 0.5],
        [1, 0, 1, 1, 5, 1, 0, 50, 0.25],
      ],
    },
  } satisfies DetailedSummary;

  test("without filters, the totals are those of every row", () => {
    const s = applyFilters(summary, noFilters());
    expect(s.by_day_machine.map((r) => [r.day, r.machine_id, r.input_tokens])).toEqual([
      ["2026-10-01", "a", 10],
      ["2026-10-01", "b", 20],
      ["2026-10-02", "a", 5],
    ]);
    expect(
      s.by_machine_source.find((r) => r.machine_id === "a" && r.source === "kimi"),
    ).toMatchObject({
      input_tokens: 5,
      cache_read_tokens: 50,
      cost_usd: 0.25,
    });
  });

  test("rows per week keep their week's first day and the bucket", () => {
    const weekly = {
      ...summary,
      bucket: "week",
      detail: { ...summary.detail, days: ["2026-09-28"], rows: summary.detail.rows.slice(0, 2) },
    } satisfies DetailedSummary;
    const s = applyFilters(weekly, noFilters());
    expect(s.bucket).toBe("week");
    expect(s.by_day_model.map((r) => [r.day, r.model, r.input_tokens])).toEqual([
      ["2026-09-28", "claude-opus-5-5", 10],
      ["2026-09-28", "k3", 20],
    ]);
  });

  test("filters keep only matching rows, in every breakdown", () => {
    const s = applyFilters(summary, { ...noFilters(), tools: ["kimi"], machines: ["a"] });
    expect(s.by_day_machine).toEqual([
      {
        day: "2026-10-02",
        machine_id: "a",
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_tokens: 0,
        cache_read_tokens: 50,
        cost_usd: 0.25,
      },
    ]);
    expect(s.by_day_model.map((r) => r.model)).toEqual(["k3"]);
    expect(s.by_day_source.map((r) => r.source)).toEqual(["kimi"]);
    expect(s.tools).toEqual(["claude", "kimi"]); // the lists of everything known stay
  });
});

describe("the dropdown's ticks", () => {
  const choices: Choice[] = [
    {
      id: "f:opus",
      label: "Opus",
      children: [
        { id: "m:claude-opus-5-5", label: "claude-opus-5-5" },
        { id: "m:claude-opus-4-5", label: "claude-opus-4-5" },
      ],
    },
    { id: "f:kimi", label: "Kimi", children: [{ id: "m:k3", label: "k3" }] },
  ];
  const tick = (selected: string[], id: string, on = true) =>
    [...toggle(new Set(selected), choices, id, on)].sort();

  test("a family stands for all its models", () => {
    expect(tick(["m:claude-opus-5-5"], "f:opus")).toEqual(["f:opus"]);
    expect(tick(["f:opus"], "f:opus", false)).toEqual([]);
  });

  test("unticking one model of a ticked family keeps the others", () => {
    expect(tick(["f:opus", "f:kimi"], "m:claude-opus-4-5", false)).toEqual([
      "f:kimi",
      "m:claude-opus-5-5",
    ]);
  });

  test("ticking the only listed model doesn't pick models the list hides", () => {
    const narrowed: Choice[] = [
      {
        id: "f:opus",
        label: "Opus",
        children: [
          { id: "m:claude-opus-5-5", label: "claude-opus-5-5" },
          { id: "m:claude-opus-4-5", label: "claude-opus-4-5", hidden: true },
        ],
      },
    ];
    expect([...toggle(new Set(), narrowed, "m:claude-opus-5-5", true)]).toEqual([
      "m:claude-opus-5-5",
    ]);
  });

  test("ticking the last model of a family ticks the family", () => {
    expect(tick(["m:claude-opus-5-5"], "m:claude-opus-4-5")).toEqual(["f:opus"]);
    expect(tick([], "m:k3")).toEqual(["f:kimi"]);
  });

  test("the button names up to two picks", () => {
    expect(describeSelection(new Set(), choices)).toBe("All");
    expect(describeSelection(new Set(["f:kimi", "f:opus"]), choices)).toBe("Opus, Kimi");
    expect(describeSelection(new Set(["m:claude-opus-4-5"]), choices)).toBe("claude-opus-4-5");
    expect(describeSelection(new Set(["f:kimi", "m:claude-opus-4-5", "x"]), choices)).toBe(
      "3 selected",
    );
  });
});

describe("what each list offers", () => {
  const rows = (...list: [string, string, string, number][]) => {
    const machines = [...new Set(list.map((r) => r[0]))];
    const sources = [...new Set(list.map((r) => r[1]))];
    const models = [...new Set(list.map((r) => r[2]))];
    return {
      timezone: "UTC",
      today: "2026-10-02",
      from: "2026-10-01",
      to: "2026-10-02",
      tools: sources,
      models,
      bucket: "day",
      detail: {
        days: ["2026-10-01"],
        machines,
        sources,
        models,
        rows: list.map(([m, t, k, n]): SummaryDetail["rows"][number] => [
          0,
          machines.indexOf(m),
          sources.indexOf(t),
          models.indexOf(k),
          n,
          0,
          0,
          0,
          0,
        ]),
      },
    } satisfies DetailedSummary;
  };
  // desk uses Claude Code (Opus) and Kimi; laptop uses Claude Code (Sonnet); idle has only empty rows.
  const s = rows(
    ["desk", "claude", "claude-opus-5-5", 10],
    ["desk", "kimi", "k3", 5],
    ["laptop", "claude", "claude-sonnet-5-5", 7],
    ["idle", "codex", "gpt-5.5", 0],
  );
  const offer = (f: Partial<ReturnType<typeof noFilters>>) => {
    const a = available(s, { ...noFilters(), ...f });
    return {
      machines: [...a.machines].sort(),
      tools: [...a.tools].sort(),
      models: [...a.models].sort(),
    };
  };

  test("with no picks, everything with usage in the period", () => {
    expect(offer({})).toEqual({
      machines: ["desk", "laptop"],
      tools: ["claude", "kimi"],
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "k3"],
    });
  });

  test("a machine narrows the tools and models, not the machines", () => {
    expect(offer({ machines: ["laptop"] })).toEqual({
      machines: ["desk", "laptop"],
      tools: ["claude"],
      models: ["claude-sonnet-5-5"],
    });
  });

  test("a tool narrows the machines and models", () => {
    expect(offer({ tools: ["kimi"] })).toEqual({
      machines: ["desk"],
      tools: ["claude", "kimi"],
      models: ["k3"],
    });
  });

  test("a model family narrows the machines and tools", () => {
    expect(offer({ families: ["sonnet"] })).toEqual({
      machines: ["laptop"],
      tools: ["claude"],
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "k3"],
    });
  });

  test("picks combine, whatever order they were made in", () => {
    expect(offer({ machines: ["laptop"], tools: ["kimi"] })).toEqual({
      machines: ["desk"],
      tools: ["claude"],
      models: [],
    });
  });
});

describe("departments", () => {
  // desk and laptop are in Design; idle has no department.
  const departmentOf = (m: string) => ({ desk: "design", laptop: "design" })[m] ?? "none";
  const summary = {
    timezone: "UTC",
    today: "2026-10-02",
    from: "2026-10-01",
    to: "2026-10-02",
    tools: ["claude", "kimi"],
    models: ["claude-opus-5-5", "k3"],
    bucket: "day",
    detail: {
      days: ["2026-10-01"],
      machines: ["desk", "laptop", "idle"],
      sources: ["claude", "kimi"],
      models: ["claude-opus-5-5", "k3"],
      rows: [
        [0, 0, 0, 0, 10, 0, 0, 0, 0],
        [0, 1, 1, 1, 20, 0, 0, 0, 0],
        [0, 2, 0, 0, 40, 0, 0, 0, 0],
      ],
    },
  } satisfies DetailedSummary;
  const f = (departments: string[]) => ({ ...noFilters(), departments });

  test("a department keeps its machines' usage", () => {
    const tokens = (departments: string[]) =>
      applyFilters(summary, f(departments), departmentOf).by_day_machine.reduce(
        (n, r) => n + r.input_tokens,
        0,
      );
    expect(tokens([])).toBe(70);
    expect(tokens(["design"])).toBe(30);
    expect(tokens(["none"])).toBe(40);
    expect(tokens(["design", "none"])).toBe(70);
  });

  test("the lists narrow by department, and the departments by the other picks", () => {
    const a = available(summary, f(["none"]), departmentOf);
    expect([...a.machines]).toEqual(["idle"]);
    expect([...a.tools]).toEqual(["claude"]);
    expect([...a.departments].sort()).toEqual(["design", "none"]);
    const kimi = available(summary, { ...noFilters(), tools: ["kimi"] }, departmentOf);
    expect([...kimi.departments]).toEqual(["design"]);
  });

  test("the machines to ask the server about", () => {
    const known = ["desk", "laptop", "idle"];
    expect(allowedMachines(noFilters(), known, departmentOf)).toBeNull();
    expect(allowedMachines(f(["design"]), known, departmentOf)).toEqual(["desk", "laptop"]);
    expect(
      allowedMachines({ ...f(["design"]), machines: ["idle", "desk"] }, known, departmentOf),
    ).toEqual(["desk"]);
    expect(allowedMachines(f(["nowhere"]), known, departmentOf)).toEqual([]);
  });
});
