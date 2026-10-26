import type { Series } from "./chart";
import { stableSeries } from "./series";

/** A family of models, such as Opus or GPT, shown as one series in the chart. */
export interface Family {
  id: string;
  label: string;
}

/** Families of other vendors' models, by a pattern in the model's name. */
const FAMILIES: [RegExp, string][] = [
  [/gpt|codex|(^|\/)o\d/, "GPT"],
  [/gemini/, "Gemini"],
  [/grok/, "Grok"],
  [/kimi|moonshot|(^|\/)k\d/, "Kimi"],
  [/qwen/, "Qwen"],
  [/glm/, "GLM"],
  [/deepseek/, "DeepSeek"],
  [/minimax/, "MiniMax"],
  [/mistral|codestral|devstral/, "Mistral"],
  [/llama/, "Llama"],
];

const named = (word: string): Family => ({
  id: word,
  label: word.charAt(0).toUpperCase() + word.slice(1),
});

/**
 * The family a model belongs to, from its name:
 * - Claude models by the word after "claude": claude-opus-5-5 and
 *   anthropic/claude-3-5-sonnet are Opus and Sonnet, and a new family such as
 *   claude-mythos-5-1 is Mythos without any change here.
 * - Other vendors' models by name: gpt-5.5 is GPT, k3 and kimi-k2.6 are Kimi.
 * - Anything else by the first word of its name: nova-pro-v1 is Nova.
 */
export function modelFamily(model: string): Family {
  const name = model.toLowerCase();
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  const claude = words.indexOf("claude");
  if (claude >= 0) {
    const word = words.slice(claude + 1).find((w) => /^[a-z]+$/.test(w));
    return word ? named(word) : { id: "claude", label: "Claude" };
  }
  for (const [pattern, label] of FAMILIES) {
    if (pattern.test(name)) return { id: label.toLowerCase(), label };
  }
  const word = /^[a-z]+/.exec(name.split("/").pop() ?? name)?.[0];
  return word ? named(word) : { id: name, label: model };
}

/**
 * Chart series for model families, keyed by family id. Families get colors
 * in the order the dashboard first saw one of their models (`models`, from
 * the summary); only when more than eight are shown at once do the newest
 * fold into "Other models" (see stableSeries).
 */
export function familySeries(models: string[], seen: Iterable<string>): Map<string, Series> {
  const labels = new Map<string, string>();
  const ids = (list: Iterable<string>) =>
    [...list].map((m) => {
      const f = modelFamily(m);
      labels.set(f.id, f.label);
      return f.id;
    });
  return stableSeries(ids(models), ids(seen), (id) => labels.get(id) ?? id, "Other models");
}
