/**
 * Claude Code logs for the rehearsal's two machines.
 *
 * If this computer has Claude Code logs, they are used: copied (so they don't
 * change during the run) and split between the two machines, file by file.
 * Only where there are none (like CI machines) are logs generated instead.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export interface MachineLogs {
  /** CLAUDE_CONFIG_DIR for the machine. */
  claudeDir: string;
  /** Log files it got, relative to its projects folder. */
  files: string[];
}

export interface LogSet {
  source: "real" | "generated";
  machines: [MachineLogs, MachineLogs];
}

/** Claude Code's data folders on this computer, as ccusage finds them. */
export function realClaudeDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.CLAUDE_CONFIG_DIR ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dirs =
    configured.length > 0
      ? configured
      : [join(homedir(), ".config", "claude"), join(homedir(), ".claude")];
  return dirs.filter((d) => existsSync(join(d, "projects")));
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** Prepares each machine's CLAUDE_CONFIG_DIR under root/<machine>/claude. */
export function prepareLogs(root: string, machineNames: [string, string]): LogSet {
  const claudeDirs = machineNames.map((m) => join(root, m, "claude")) as [string, string];
  for (const d of claudeDirs) mkdirSync(join(d, "projects"), { recursive: true });
  const machines: [MachineLogs, MachineLogs] = [
    { claudeDir: claudeDirs[0], files: [] },
    { claudeDir: claudeDirs[1], files: [] },
  ];

  const real = realClaudeDirs().flatMap((d) =>
    jsonlFiles(join(d, "projects")).map((rel) => ({ from: join(d, "projects", rel), rel })),
  );
  if (real.length > 0) {
    // Alternate files between the machines: with one session and one
    // subagent log, each machine gets one of them.
    real.forEach((file, i) => {
      const m = machines[i % 2] as MachineLogs;
      const to = join(m.claudeDir, "projects", file.rel);
      if (existsSync(to)) return; // same file under two data folders
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(file.from, to);
      m.files.push(file.rel);
    });
    return { source: "real", machines };
  }

  generateLogs(machines);
  return { source: "generated", machines };
}

/** Writes a few days of plausible Claude Code logs for each machine. */
function generateLogs(machines: [MachineLogs, MachineLogs]): void {
  const plans = [
    [
      {
        daysAgo: 1,
        model: "claude-opus-5-5",
        input: 1200,
        output: 48000,
        create: 220000,
        read: 3100000,
      },
      {
        daysAgo: 1,
        model: "claude-sonnet-5-5",
        input: 800,
        output: 21000,
        create: 90000,
        read: 1400000,
      },
      {
        daysAgo: 4,
        model: "claude-opus-5-5",
        input: 300,
        output: 15000,
        create: 60000,
        read: 900000,
      },
    ],
    [
      {
        daysAgo: 2,
        model: "claude-sonnet-5-5",
        input: 500,
        output: 30000,
        create: 120000,
        read: 2000000,
      },
      {
        daysAgo: 2,
        model: "claude-haiku-5-5",
        input: 2000,
        output: 9000,
        create: 15000,
        read: 250000,
      },
    ],
  ];
  machines.forEach((m, mi) => {
    const lines: string[] = [];
    plans[mi]?.forEach((p, i) => {
      const day = new Date(Date.now() - p.daysAgo * 86_400_000);
      day.setUTCHours(15, i, 0, 0);
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: day.toISOString(),
          sessionId: `rehearsal-${mi}`,
          requestId: `req_rehearsal_${mi}_${i}`,
          version: "2.1.0",
          cwd: "/home/dev/project",
          message: {
            id: `msg_rehearsal_${mi}_${i}`,
            model: p.model,
            usage: {
              input_tokens: p.input,
              output_tokens: p.output,
              cache_creation_input_tokens: p.create,
              cache_read_input_tokens: p.read,
            },
          },
        }),
      );
    });
    const rel = join("-home-dev-project", `rehearsal-${mi}.jsonl`);
    mkdirSync(join(m.claudeDir, "projects", "-home-dev-project"), { recursive: true });
    writeFileSync(join(m.claudeDir, "projects", rel), `${lines.join("\n")}\n`);
    m.files.push(rel);
  });
}

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/** What ccusage itself reports for a Claude data folder: the expected dashboard numbers. */
export function ccusageTotals(
  ccusage: string,
  claudeDir: string,
  timezone: string,
  days?: { since: string; until: string },
): Totals {
  const range = days
    ? ["--since", days.since.replaceAll("-", ""), "--until", days.until.replaceAll("-", "")]
    : [];
  const out = execFileSync(
    ccusage,
    ["claude", "daily", "--json", "--timezone", timezone, "--offline", ...range],
    {
      env: { PATH: process.env.PATH, HOME: dirname(claudeDir), CLAUDE_CONFIG_DIR: claudeDir },
      maxBuffer: 64 << 20,
    },
  ).toString();
  const report = JSON.parse(out) as {
    totals?: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalCost: number;
    };
  };
  const t = report.totals;
  return {
    input_tokens: t?.inputTokens ?? 0,
    output_tokens: t?.outputTokens ?? 0,
    cache_creation_tokens: t?.cacheCreationTokens ?? 0,
    cache_read_tokens: t?.cacheReadTokens ?? 0,
    cost_usd: t?.totalCost ?? 0,
  };
}
