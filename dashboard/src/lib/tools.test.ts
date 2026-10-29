import { describe, expect, test } from "vitest";
import toolsGo from "../../../agent/internal/ccusage/tools.go?raw";
import { OTHER, seriesOf } from "./series";
import { TOOL_NAMES, toolList, toolName, toolSeries } from "./tools";

describe("tools", () => {
  test("the names match the program's list of the tools ccusage reads", () => {
    const fromGo = Object.fromEntries(
      [...toolsGo.matchAll(/\{"([a-z0-9_-]+)", "([^"]+)"\}/g)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(fromGo).length).toBeGreaterThan(10);
    expect(TOOL_NAMES).toEqual(fromGo);
  });

  test("unknown tools show their id", () => {
    expect(toolName("codex")).toBe("Codex");
    expect(toolName("newtool")).toBe("newtool");
    expect(toolName("constructor")).toBe("constructor");
  });

  test("tools keep their colors in the order the dashboard first saw them", () => {
    const series = toolSeries(["codex", "claude"], ["gemini", "claude"]);
    expect([...series.values()].map((s) => `${s.label} ${s.colorClass}`)).toEqual([
      "Codex s1",
      "Claude Code s2",
      "Gemini CLI s3",
    ]);
    // Seeing fewer tools in a period never repaints the others.
    expect(toolSeries(["codex", "claude"]).get("claude")?.colorClass).toBe("s2");
  });

  test("past eight tools shown at once, the newest fold into Other tools", () => {
    const ids = Object.keys(TOOL_NAMES).slice(0, 9);
    const series = toolSeries(ids, ids);
    expect(series.get(ids[6] ?? "")?.colorClass).toBe("s7");
    expect(series.get(ids[7] ?? "")).toEqual({
      id: OTHER,
      label: "Other tools",
      colorClass: "s-other",
    });
    expect(series.get(ids[8] ?? "")?.id).toBe(OTHER);
  });

  test("a tool called other stays apart from Other tools", () => {
    const ids = ["other", ...Object.keys(TOOL_NAMES).slice(0, 8)];
    const series = toolSeries(ids, ids);
    expect(series.get("other")).toEqual({ id: "other", label: "other", colorClass: "s1" });
    expect(seriesOf(series, ids).map((s) => s.label)).toEqual([
      "other",
      ...ids.slice(1, 7).map(toolName),
      "Other tools",
    ]);
  });

  test("a machine's tools are listed in the dashboard's order", () => {
    expect(toolList(["gemini", "zz", "claude"], ["claude", "gemini"])).toBe(
      "Claude Code, Gemini CLI, zz",
    );
  });
});
