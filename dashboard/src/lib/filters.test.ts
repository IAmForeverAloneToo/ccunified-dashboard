import { describe, expect, test } from "vitest";
import type { Summary } from "./api";
import {
  allowedModels,
  applyFilters,
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
      machines: ["m1", "m2"],
      tools: ["kimi"],
      families: ["opus"],
      models: ["a,b model"],
    });
    expect(q.get("range")).toBe("30");
    expect(q.getAll("machine")).toEqual(["m1", "m2"]);
    expect(readFilters(new URLSearchParams(q.toString()))).toEqual({
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
    by_day_machine: [],
    by_day_model: [],
    by_day_source: [],
    by_machine_source: [],
    detail: {
      machines: ["a", "b"],
      sources: ["claude", "kimi"],
      models: ["claude-opus-5-5", "k3"],
      rows: [
        ["2026-10-01", 0, 0, 0, 10, 1, 0, 100, 1.5],
        ["2026-10-01", 1, 1, 1, 20, 2, 0, 200, 0.5],
        ["2026-10-02", 0, 1, 1, 5, 1, 0, 50, 0.25],
      ],
    },
  } satisfies Summary;

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
