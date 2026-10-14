/**
 * Usage logs for the rehearsal's two machines: Claude Code's, Codex's and
 * OpenCode's.
 *
 * For each tool, this computer's own logs are used if it has any: copied (so
 * they don't change during the run) and split between the two machines, file
 * by file. Only where there are none (like CI machines) are logs generated
 * instead: Claude Code's for both machines, Codex's for the first and
 * OpenCode's for the second.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const TOOLS = ["claude", "codex", "opencode"] as const;
export type Tool = (typeof TOOLS)[number];

export interface MachineLogs {
  /** HOME for the machine; Codex and OpenCode keep their logs under it. */
  home: string;
  /** CLAUDE_CONFIG_DIR for the machine. */
  claudeDir: string;
  /** Log files it got for each tool, relative to that tool's log folder. */
  files: Record<Tool, string[]>;
}

export interface LogSet {
  source: Record<Tool, "real" | "generated">;
  machines: [MachineLogs, MachineLogs];
}

export const fileCount = (m: MachineLogs) => TOOLS.reduce((n, t) => n + m.files[t].length, 0);

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

/** Where each tool keeps its logs: on this computer, and on a rehearsal machine. */
const LOG_FOLDERS: Record<
  Tool,
  { real: () => string[]; machine: (m: MachineLogs) => string; ext: string }
> = {
  claude: {
    real: () => realClaudeDirs().map((d) => join(d, "projects")),
    machine: (m) => join(m.claudeDir, "projects"),
    ext: ".jsonl",
  },
  codex: {
    real: () => [join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")],
    machine: (m) => join(m.home, ".codex", "sessions"),
    ext: ".jsonl",
  },
  opencode: {
    real: () => [
      join(
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "message",
      ),
    ],
    machine: (m) => join(m.home, ".local", "share", "opencode", "storage", "message"),
    ext: ".json",
  },
};

function filesIn(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** Prepares each machine's home and CLAUDE_CONFIG_DIR under root/<machine>. */
export function prepareLogs(root: string, machineNames: [string, string]): LogSet {
  const machines = machineNames.map((name) => {
    const m: MachineLogs = {
      home: join(root, name, "home"),
      claudeDir: join(root, name, "claude"),
      files: { claude: [], codex: [], opencode: [] },
    };
    mkdirSync(join(m.claudeDir, "projects"), { recursive: true });
    mkdirSync(m.home, { recursive: true });
    return m;
  }) as [MachineLogs, MachineLogs];

  const source = {} as LogSet["source"];
  for (const tool of TOOLS) {
    const folders = LOG_FOLDERS[tool];
    const real = folders
      .real()
      .flatMap((dir) => filesIn(dir, folders.ext).map((rel) => ({ from: join(dir, rel), rel })));
    if (real.length === 0) {
      GENERATE[tool](machines);
      source[tool] = "generated";
      continue;
    }
    // Alternate files between the machines: with one session and one
    // subagent log, each machine gets one of them.
    real.forEach((file, i) => {
      const m = machines[i % 2] as MachineLogs;
      const to = join(folders.machine(m), file.rel);
      if (existsSync(to)) return; // same file under two data folders
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(file.from, to);
      m.files[tool].push(file.rel);
    });
    source[tool] = "real";
  }
  return { source, machines };
}

const at = (daysAgo: number, minute: number) => {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  day.setUTCHours(15, minute, 0, 0);
  return day;
};

const write = (m: MachineLogs, tool: Tool, rel: string, content: string) => {
  const to = join(LOG_FOLDERS[tool].machine(m), rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, content);
  m.files[tool].push(rel);
};

const GENERATE: Record<Tool, (machines: [MachineLogs, MachineLogs]) => void> = {
  /** A few days of plausible Claude Code logs for each machine. */
  claude(machines) {
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
      const lines = (plans[mi] ?? []).map((p, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: at(p.daysAgo, i).toISOString(),
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
      write(
        m,
        "claude",
        join("-home-dev-project", `rehearsal-${mi}.jsonl`),
        `${lines.join("\n")}\n`,
      );
    });
  },

  /** One Codex session on the first machine: two requests, the second a day later. */
  codex([m]) {
    const start = at(3, 0);
    const later = at(2, 30);
    const usage = (input: number, cached: number, output: number) => ({
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: Math.round(output / 3),
      total_tokens: input + output,
    });
    const lines = [
      {
        timestamp: start.toISOString(),
        type: "session_meta",
        payload: {
          id: "rehearsal-codex",
          timestamp: start.toISOString(),
          cwd: "/home/dev/project",
          originator: "codex_cli_rs",
          cli_version: "0.60.0",
        },
      },
      {
        timestamp: start.toISOString(),
        type: "turn_context",
        payload: {
          cwd: "/home/dev/project",
          approval_policy: "on-request",
          model: "gpt-5.5",
          effort: "medium",
          summary: "auto",
        },
      },
      {
        timestamp: start.toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: usage(42000, 30000, 3100),
            last_token_usage: usage(42000, 30000, 3100),
            model_context_window: 272000,
          },
        },
      },
      {
        timestamp: later.toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: usage(97000, 70000, 5300),
            last_token_usage: usage(55000, 40000, 2200),
            model_context_window: 272000,
          },
        },
      },
    ];
    const day = start.toISOString().slice(0, 10).replaceAll("-", "/");
    write(
      m,
      "codex",
      join(day, "rollout-rehearsal.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  },

  /** Two OpenCode messages on the second machine, with the cost OpenCode recorded. */
  opencode([, m]) {
    [
      {
        daysAgo: 1,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        input: 1500,
        output: 4200,
        read: 80000,
        write: 6000,
        cost: 0.07,
      },
      {
        daysAgo: 3,
        provider: "openai",
        model: "gpt-5.5",
        input: 9000,
        output: 1100,
        read: 12000,
        write: 0,
        cost: 0.02,
      },
    ].forEach((p, i) => {
      const created = at(p.daysAgo, 10 + i).getTime();
      write(
        m,
        "opencode",
        join("ses_rehearsal", `msg_rehearsal_${i}.json`),
        JSON.stringify({
          id: `msg_rehearsal_${i}`,
          sessionID: "ses_rehearsal",
          role: "assistant",
          providerID: p.provider,
          modelID: p.model,
          time: { created, completed: created + 5000 },
          tokens: {
            input: p.input,
            output: p.output,
            reasoning: 0,
            cache: { read: p.read, write: p.write },
          },
          cost: p.cost,
        }),
      );
    });
  },
};

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

const zero = (): Totals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_usd: 0,
});

interface RawTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
}

/**
 * What ccusage itself reports for a machine's logs, in total, per tool, and
 * per tool and model: the numbers the dashboard must show.
 */
export function ccusageTotals(
  ccusage: string,
  m: MachineLogs,
  timezone: string,
  days?: { since: string; until: string },
): {
  total: Totals;
  byTool: Record<string, Totals>;
  byToolModel: Record<string, Record<string, Totals>>;
} {
  const range = days
    ? ["--since", days.since.replaceAll("-", ""), "--until", days.until.replaceAll("-", "")]
    : [];
  const out = execFileSync(
    ccusage,
    ["daily", "--json", "--by-agent", "--timezone", timezone, "--offline", ...range],
    {
      env: { PATH: process.env.PATH, HOME: m.home, CLAUDE_CONFIG_DIR: m.claudeDir },
      maxBuffer: 64 << 20,
    },
  ).toString();
  const report = JSON.parse(out) as {
    daily: {
      agents: (RawTotals & {
        agent: string;
        modelBreakdowns: (Omit<RawTotals, "totalCost"> & { modelName: string; cost: number })[];
      })[];
    }[];
  };
  const total = zero();
  const byTool: Record<string, Totals> = {};
  const byToolModel: Record<string, Record<string, Totals>> = {};
  for (const row of report.daily) {
    for (const a of row.agents) {
      const t = byTool[a.agent] ?? zero();
      byTool[a.agent] = t;
      for (const into of [t, total]) {
        into.input_tokens += a.inputTokens;
        into.output_tokens += a.outputTokens;
        into.cache_creation_tokens += a.cacheCreationTokens;
        into.cache_read_tokens += a.cacheReadTokens;
        into.cost_usd += a.totalCost;
      }
      const models = byToolModel[a.agent] ?? {};
      byToolModel[a.agent] = models;
      for (const m of a.modelBreakdowns) {
        const into = models[m.modelName] ?? zero();
        models[m.modelName] = into;
        into.input_tokens += m.inputTokens;
        into.output_tokens += m.outputTokens;
        into.cache_creation_tokens += m.cacheCreationTokens;
        into.cache_read_tokens += m.cacheReadTokens;
        into.cost_usd += m.cost;
      }
    }
  }
  return { total, byTool, byToolModel };
}
