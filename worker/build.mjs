// Bundles the Worker, with the built dashboard inside it, into a single ES
// module: the form the Cloudflare API accepts and the ccunified program embeds.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDist = join(here, "../dashboard/dist");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const PLACEHOLDER = {
  "/index.html": {
    type: CONTENT_TYPES[".html"],
    body: "<!doctype html><title>ccunified</title><p>Dashboard not built.</p>",
  },
};

/** @param {string} dir */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/**
 * Reads the built dashboard (dashboard/dist) into a path → file map.
 * @param {boolean} required fail if the dashboard has not been built
 */
async function dashboardAssets(required) {
  if (!existsSync(join(dashboardDist, "index.html"))) {
    if (required) throw new Error("dashboard/dist is missing: run `npm run build -w dashboard`");
    return PLACEHOLDER;
  }
  /** @type {Record<string, { type: string, body: string }>} */
  const assets = {};
  for (const file of await listFiles(dashboardDist)) {
    const type = CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (extname(file))];
    if (!type) throw new Error(`unsupported dashboard file type: ${file}`);
    const path = `/${relative(dashboardDist, file).split(sep).join("/")}`;
    assets[path] = { type, body: await readFile(file, "utf8") };
  }
  return assets;
}

/**
 * @param {{ version?: string, repo?: string, requireDashboard?: boolean }} [options]
 * @returns {Promise<string>} the bundled Worker source
 */
export async function bundleWorker(options = {}) {
  const assets = await dashboardAssets(options.requireDashboard ?? false);
  /** @type {esbuild.Plugin} */
  const assetsPlugin = {
    name: "dashboard-assets",
    setup(build) {
      build.onResolve({ filter: /^virtual:dashboard-assets$/ }, (args) => ({
        path: args.path,
        namespace: "dashboard-assets",
      }));
      build.onLoad({ filter: /.*/, namespace: "dashboard-assets" }, () => ({
        contents: `export const assets = ${JSON.stringify(assets)};`,
        loader: "js",
      }));
    },
  };
  /** @type {Record<string, string>} */
  const define = { __CCUNIFIED_VERSION__: JSON.stringify(options.version ?? "dev") };
  if (options.repo) define.__CCUNIFIED_REPO__ = JSON.stringify(options.repo);

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
    define,
    plugins: [assetsPlugin],
  });
  const [file] = result.outputFiles;
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.env.CCUNIFIED_VERSION ?? "dev";
  const code = await bundleWorker({
    version,
    repo: process.env.CCUNIFIED_REPO,
    requireDashboard: true,
  });
  const outfile = join(here, "dist/worker.js");
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, code);
  console.log(`wrote ${outfile} (${code.length} bytes, version ${version})`);
}
