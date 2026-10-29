import { describe, expect, test } from "vitest";
import { familySeries, modelFamily } from "./models";
import { OTHER } from "./series";

describe("model families", () => {
  test.each([
    ["claude-opus-5-5", "Opus"],
    ["claude-sonnet-5-5", "Sonnet"],
    ["claude-haiku-5-5", "Haiku"],
    ["claude-fable-5-1", "Fable"],
    ["claude-mythos-5-1", "Mythos"],
    ["claude-3-5-sonnet-20241022", "Sonnet"],
    ["anthropic/claude-sonnet-5-5", "Sonnet"],
    ["us.anthropic.claude-opus-4-5-20251101-v1:0", "Opus"],
    ["claude-sonnet-4.5", "Sonnet"],
    ["claude-2", "Claude"],
    ["gpt-5.5", "GPT"],
    ["openai/gpt-5", "GPT"],
    ["gpt-5.3-codex", "GPT"],
    ["o3", "GPT"],
    ["o4-mini", "GPT"],
    ["gemini-3-pro", "Gemini"],
    ["google/gemini-3-flash", "Gemini"],
    ["grok-code-fast-1", "Grok"],
    ["k3", "Kimi"],
    ["kimi-k2.6", "Kimi"],
    ["moonshot/kimi-k3", "Kimi"],
    ["qwen3-coder-plus", "Qwen"],
    ["glm-4.6", "GLM"],
    ["zai/glm-5", "GLM"],
    ["deepseek-v3", "DeepSeek"],
    ["minimax-m2", "MiniMax"],
    ["devstral-medium", "Mistral"],
    ["nova-pro-v1", "Nova"],
    ["amazon/nova-lite", "Nova"],
    ["4o", "4o"],
  ])("%s is %s", (model, family) => {
    expect(modelFamily(model).label).toBe(family);
  });

  test("families keep their colors in the order the dashboard first saw them", () => {
    const models = ["claude-opus-5-5", "k3", "claude-opus-4-5", "claude-mythos-5-1"];
    const series = familySeries(models, ["claude-mythos-5-1", "k3"]);
    expect([...series.values()].map((s) => `${s.label} ${s.colorClass}`)).toEqual([
      "Opus s1",
      "Kimi s2",
      "Mythos s3",
    ]);
    // A model the order doesn't list yet comes after, without repainting the rest.
    const later = familySeries(models, ["gpt-5.5"]);
    expect(later.get("gpt")?.colorClass).toBe("s4");
    expect(later.get("kimi")?.colorClass).toBe("s2");
  });

  test("past eight families, the newest share Other models", () => {
    const models = [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "gpt-5.5",
      "gemini-3-pro",
      "k3",
      "qwen3-coder",
      "glm-5",
      "deepseek-v3",
    ];
    const series = familySeries(models, models);
    expect(series.get("qwen")?.colorClass).toBe("s7");
    expect(series.get("glm")).toEqual({
      id: OTHER,
      label: "Other models",
      colorClass: "s-other",
    });
    expect(series.get("deepseek")?.id).toBe(OTHER);
  });

  test("a period with eight families or fewer names each, even after more than eight overall", () => {
    // Nine families seen over time; Kimi came last.
    const models = [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "gpt-5.5",
      "gemini-3-pro",
      "glm-5",
      "k3.1-pro",
    ];
    const series = familySeries(models, ["claude-opus-5-5", "k3.1-pro"]);
    expect(series.get("opus")?.colorClass).toBe("s1");
    // Kimi gets a color no other family in view uses, not the gray fold.
    expect(series.get("kimi")).toMatchObject({ id: "kimi", label: "Kimi" });
    expect(series.get("kimi")?.colorClass).toMatch(/^s[2-8]$/);
  });
});
