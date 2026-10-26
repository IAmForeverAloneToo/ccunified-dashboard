import type { Series } from "./chart";
import { stableSeries } from "./series";

/**
 * The tools ccusage reads, by id, with the names its help gives them. The
 * list matches the pinned ccusage (agent/internal/ccusage/tools.go; checked by
 * tools.test.ts).
 */
export const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes",
  pi: "pi-agent",
  goose: "Goose",
  kilo: "Kilo",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  kimi: "Kimi",
  qwen: "Qwen",
  openclaw: "OpenClaw",
  grok: "Grok Build CLI",
  zcode: "ZCode",
};

/** A tool's name, or its id for a tool this dashboard doesn't know. */
export function toolName(id: string): string {
  return Object.hasOwn(TOOL_NAMES, id) ? (TOOL_NAMES[id] ?? id) : id;
}

/**
 * Chart series for tools. Tools keep the color of their position in the
 * order the dashboard first saw them, so new tools never repaint old ones.
 * Past eight tools shown at once, the newest fold into a gray "Other tools".
 */
export function toolSeries(order: string[], seen: Iterable<string> = []): Map<string, Series> {
  return stableSeries(order, seen, toolName, "Other tools");
}

/** Names a machine's tools, in the dashboard's order. */
export function toolList(tools: string[], order: string[]): string {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...tools]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(toolName)
    .join(", ");
}
