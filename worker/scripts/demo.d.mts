import type { Miniflare } from "miniflare";

/** Runs the Worker with a throwaway database full of sample data (see demo.mjs). */
export function startDemo(options?: {
  /** 0 picks a free port. */
  port?: number;
  seed?: boolean;
  quiet?: boolean;
}): Promise<{
  mf: Miniflare;
  url: string;
  db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  /** The stand-in GitHub: the newest release it reports, and whether it answers. */
  github: { latest: string; reachable: boolean };
}>;
