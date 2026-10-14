// Bundles the Worker into a single ES module, the form the Cloudflare API
// accepts and the form the ccunified program embeds.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ version?: string }} [options]
 * @returns {Promise<string>} the bundled Worker source
 */
export async function bundleWorker(options = {}) {
  const result = await esbuild.build({
    entryPoints: [join(here, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    minify: true,
    legalComments: "none",
    write: false,
    define: {
      __CCUNIFIED_VERSION__: JSON.stringify(options.version ?? "dev"),
    },
  });
  const [file] = result.outputFiles;
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.env.CCUNIFIED_VERSION ?? "dev";
  const code = await bundleWorker({ version });
  const outfile = join(here, "dist/worker.js");
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, code);
  console.log(`wrote ${outfile} (${code.length} bytes, version ${version})`);
}
