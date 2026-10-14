/**
 * One simulated computer in the rehearsal: its own home, settings and Claude
 * Code logs, running the real ccunified program.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Network {
  /** CCUNIFIED_CLOUDFLARE_API */
  cloudflareApi: string;
  /** Proxy that routes the dashboard's domain to this computer. */
  proxy: string;
  /** Certificate the dashboard's domain uses. */
  certFile: string;
  /** Public DNS (CCUNIFIED_DOH_URL). */
  publicDns: string;
}

export class Machine {
  readonly home: string;
  readonly configDir: string;

  constructor(
    readonly name: string,
    root: string,
    private readonly exe: string,
    readonly claudeDir: string,
    private readonly network: Network,
  ) {
    this.home = join(root, name, "home");
    this.configDir = join(root, name, "ccunified");
    mkdirSync(this.home, { recursive: true });
  }

  /** A clean environment: nothing leaks in from the computer running the rehearsal. */
  env(): NodeJS.ProcessEnv {
    const { proxy } = this.network;
    return {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      HOME: this.home,
      CCUNIFIED_HOME: this.configDir,
      CLAUDE_CONFIG_DIR: this.claudeDir,
      CCUNIFIED_CCUSAGE_OFFLINE: "1",
      CCUNIFIED_CLOUDFLARE_API: this.network.cloudflareApi,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      SSL_CERT_FILE: this.network.certFile,
      CCUNIFIED_DOH_URL: this.network.publicDns,
    };
  }

  /** Starts a command whose questions are answered with Session.answer. */
  start(...args: string[]): Session {
    return new Session(this.name, spawn(this.exe, args, { env: this.env() }));
  }

  /** Runs a command to the end and returns its output. */
  async run(...args: string[]): Promise<{ code: number; output: string }> {
    const session = this.start(...args);
    session.close();
    const code = await session.exit();
    return { code, output: session.output };
  }
}

export class Session {
  output = "";
  private cursor = 0;
  private exitCode: number | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly label: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    const onData = (chunk: Buffer) => {
      this.output += chunk.toString();
      for (const l of this.listeners) l();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      this.exitCode = code ?? -1;
      for (const l of this.listeners) l();
    });
  }

  /**
   * Waits for text to appear after the previous match, like a person reading
   * the screen, and returns the match.
   */
  expect(pattern: RegExp | string, timeoutMs = 60_000): Promise<RegExpExecArray> {
    const re =
      typeof pattern === "string"
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        : pattern;
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = re.exec(this.output.slice(this.cursor));
        if (m) {
          this.cursor += m.index + m[0].length;
          done();
          resolve(m);
        } else if (this.exitCode !== undefined) {
          done();
          reject(this.failure(`exited (${this.exitCode}) before showing ${re}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(this.failure(`didn't show ${re} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Types a line, as if at the keyboard. */
  answer(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  /** Ends the input (like Ctrl+D). */
  close(): void {
    this.child.stdin.end();
  }

  exit(timeoutMs = 120_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.exitCode === undefined) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(this.exitCode);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        this.child.kill();
        reject(this.failure(`didn't finish within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  private failure(what: string): Error {
    return new Error(`${this.label}: ccunified ${what}. Its output:\n${this.output}`);
  }
}
