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
}>;
