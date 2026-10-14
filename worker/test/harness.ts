import { Miniflare } from "miniflare";
import { bundleWorker } from "../build.mjs";

let bundled: Promise<string> | undefined;

/** Starts the bundled Worker in workerd (Cloudflare's runtime) with an empty D1 database. */
export async function startWorker(): Promise<Miniflare> {
  bundled ??= bundleWorker({ version: "test" });
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "ccunified-test",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await bundled } },
          },
          env: { DB: { type: "d1", id: "ccunified-test" } },
        },
      },
    ],
  });
  await mf.ready;
  return mf;
}
