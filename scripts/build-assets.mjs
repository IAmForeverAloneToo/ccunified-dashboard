// Builds the dashboard and the Worker, then copies the Worker bundle and the
// database migrations into the Go program (agent/internal/serverassets/assets),
// so ccunified can set up and update the Cloudflare side by itself.
//
//   CCUNIFIED_VERSION=1.2.3 node scripts/build-assets.mjs
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleWorker } from "../worker/build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "agent/internal/serverassets/assets");
const version = process.env.CCUNIFIED_VERSION ?? "dev";

execFileSync("npm", ["run", "build", "-w", "dashboard"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const worker = await bundleWorker({
  version,
  repo: process.env.CCUNIFIED_REPO,
  requireDashboard: true,
});
await writeFile(join(out, "worker.js"), worker);

await rm(join(out, "migrations"), { recursive: true, force: true });
await mkdir(join(out, "migrations"), { recursive: true });
const migrations = (await readdir(join(root, "worker/migrations")))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of migrations)
  await copyFile(join(root, "worker/migrations", f), join(out, "migrations", f));

console.log(
  `assets: worker.js (${worker.length} bytes, version ${version}) + ${migrations.length} migration(s) -> ${out}`,
);
