# Development

## Requirements

- **Node.js 24 LTS** (24.15 or later) with **npm 12.2** or later, for the
  Worker and dashboard. `npm install -g npm@12` if your Node.js came with an
  older npm.
- **Go 1.27** or later, for the `ccunified` program.
- For the browser tests: **Google Chrome** and Playwright's **Firefox**
  (`npx playwright install chrome firefox` installs the current versions).
  The full rehearsal also needs **Linux** and `openssl`.

The project always uses the latest versions of its tools, libraries and GitHub
Actions; when you upgrade one, upgrade it to the newest release.

## Repository layout

```
agent/        Go: the ccunified program
  cmd/ccunified/        entry point
  internal/cli/         commands
  internal/setup/       the setup wizard and the server commands
  internal/syncer/      runs ccusage and uploads
  internal/ccusage/     finds, verifies and runs the bundled ccusage (pinned.json, tools.go)
  internal/cloudflare/  Cloudflare REST API client
  internal/schedule/    Task Scheduler, systemd and cron
  internal/update/      self-update
  tools/fetchccusage/   downloads and verifies the pinned ccusage
  tools/release/        builds release archives
worker/       TypeScript: the Cloudflare Worker, its D1 migrations and tests
dashboard/    TypeScript: the dashboard pages (bundled into the Worker)
schema/       the upload format (JSON Schema), example uploads, login test vectors
e2e/          the full rehearsal
scripts/      install.sh, install.ps1, build-assets.mjs
docs/         documentation
.github/      CI and release workflows
```

## Everyday commands

```sh
npm ci                 # install the JavaScript tooling
npm run lint           # Biome (formatting and lint)
npm run format         # fix what Biome can fix
npm run typecheck      # TypeScript
npm test               # Worker tests, inside workerd
npm run build          # build the dashboard and bundle the Worker
npm run check          # all of the above, plus the Go checks and tests
npm run demo           # the dashboard with demo data at http://localhost:8787
                       # (log in as demo, sam, morgan, riley, jordan or casey;
                       # the password is "<name>-password")
npm run test:browser   # dashboard tests in Chrome and Firefox
npm run rehearsal      # the full rehearsal (Linux)
```

For the Go program:

```sh
cd agent
go run ./tools/fetchccusage   # the pinned ccusage for this platform (once)
go vet ./... && go test ./...
```

`npm run check` is what CI runs; run it before pushing.

## Tests

- **Worker:** Vitest tests run the bundled Worker inside workerd, Cloudflare's
  real runtime, against a real D1 database, through Miniflare. They cover the
  upload rules, logins, roles, two-factor, pairing and attack cases such as
  forged requests and brute-forcing.
- **Upload format:** the Zod schema in `worker/src/ingest/schema.ts` is the
  source of truth; `schema/ingest.schema.json` is generated from it
  (`UPDATE_SCHEMA=1 npm test -w worker` rewrites it). The example uploads in
  `schema/examples/`, in both formats, must be accepted or rejected by both
  the Worker and the Go program; see [its README](../schema/examples/README.md).
  The Worker tests also apply each migration to a database from the previous
  release.
- **Dashboard:** unit tests for the date logic, filters, model families and the tool names and colors
  (`dashboard/src/lib/*.test.ts`, part of `npm test`), and browser tests
  (`npm run test:browser`) in Chrome and Firefox against the demo data: the
  date range picker (mouse, keyboard, typed dates, shortcuts, cancelling,
  future days, usage dots, reload and Back, phone layout, totals matching the
  API), splitting by tool, model families and their colors, the filters
  (each one, combined, families and exact models, reload and Back, the
  keyboard, the date picker's dots, phone width), the Settings page's update
  check, and the Machines page's tools.
- **Login keys:** `schema/test-vectors/login-kdf.json` holds password-to-key
  results that the browser code, the Worker tests and the Go program must all
  reproduce.
- **Go:** unit tests for every package, including the setup wizard against a
  simulated Cloudflare API with an SQLite stand-in for D1, updating a
  dashboard from the first release, and syncing with the real ccusage against
  sample Claude Code and Codex logs, to an updated dashboard and to one that
  accepts Claude Code only. A test checks that the program's list of tools
  (`internal/ccusage/tools.go`) is exactly what the pinned ccusage reads.
- **Real background schedule:** with `CCUNIFIED_TEST_SCHEDULER=1`,
  `go test ./internal/schedule/ -run Integration` installs the real Task
  Scheduler task or systemd timer, waits for it to upload to a local test
  dashboard, then removes it. CI runs it on Windows and Linux; it changes your
  real schedule, so it's off by default.
- **Installers:** CI checks `install.sh` with shellcheck and `install.ps1`
  with PowerShell 5.1 and 7. The Release workflow installs, runs and
  uninstalls every build on Windows and Linux.

### The full rehearsal

`npm run rehearsal` (in `e2e/`) runs the whole flow with the real program and a
real browser:

1. Builds the dashboard into the program and compiles `ccunified`.
2. Starts a stand-in Cloudflare (`e2e/src/fake-cloudflare.ts`): the REST API
   the wizard uses, D1 and the uploaded Worker running in workerd, the custom
   domain served over HTTPS, and public DNS that publishes a new subdomain
   after a delay, as Cloudflare does.
3. Machine one runs `ccunified setup` and creates the dashboard, answering the
   prompts like a person would (including a rejected token and a taken
   subdomain).
4. Google Chrome logs in. Machine two joins; Chrome approves its code.
5. Checks that the dashboard shows exactly what ccusage reports for each
   machine's logs, per machine and per tool, in the API and on the page, that
   syncing again changes nothing, that a custom date range matches
   ccusage's numbers for the same days, and that filtering by each tool, by a
   machine and a tool, and by each model family shows exactly ccusage's
   numbers for those, with every family named in the chart.

The machines use Claude Code, Codex and OpenCode logs. For each tool it uses
**this computer's real logs** when there are any, copied and split between
the two machines file by file; the copies are deleted afterwards. Where there
are none, as on CI, it generates logs (Codex's on the first machine,
OpenCode's on the second). Screenshots go to `e2e/test-results/`.

## Updating the docs' screenshots

The screenshots in `docs/images/` show the demo data. Run `npm run demo`, then
capture the Overview (30 days, split by machine, and split by tool), the
Models filter open, the Machines page and the date picker at 1280 px wide in light and dark mode, at
2× scale.

## Upgrading ccusage

1. In `agent/internal/ccusage/pinned.json`, set the new version and each
   platform's npm `integrity` (from `npm view @ccusage/ccusage-<platform>@<version> dist.integrity`).
2. `go run ./tools/fetchccusage -all -update` downloads every platform, checks
   the integrity and fills in the SHA-256 values.
3. If the new version reads other tools, update `Tools` in
   `agent/internal/ccusage/tools.go` and `TOOL_NAMES` in
   `dashboard/src/lib/tools.ts`; the Go and dashboard tests compare both with
   what `ccusage --help` lists.
4. Run the tests and the rehearsal.

## Environment variables

For testing and development only:

| Variable | Effect |
|---|---|
| `CCUNIFIED_CCUSAGE` | Run this ccusage instead of the bundled one (still checksum-verified) |
| `CCUNIFIED_CCUSAGE_UNVERIFIED=1` | Skip the checksum check for `CCUNIFIED_CCUSAGE` |
| `CCUNIFIED_CCUSAGE_OFFLINE=1` | Always use ccusage's built-in prices |
| `CCUNIFIED_REQUIRE_CCUSAGE=1` | Go tests fail, instead of skipping, when ccusage is missing (set in CI) |
| `CCUNIFIED_CLOUDFLARE_API` | Cloudflare API base URL for the wizard and `server` commands |
| `CCUNIFIED_DOH_URL` | DNS-over-HTTPS endpoint used instead of Cloudflare's public DNS |
| `CCUNIFIED_TEST_SCHEDULER=1` | Enables the real background-schedule test |
| `CCUNIFIED_VERSION`, `CCUNIFIED_REPO` | Version and repository built into the Worker by `npm run build:assets` |
| `CCUNIFIED_DOWNLOAD_BASE`, `CCUNIFIED_REPO` | Installers: download from this address, or from another repository's releases |

User-facing variables are in the [command reference](commands.md#environment-variables).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `Main` and on pull requests:
the Worker and dashboard checks, the Go tests on Windows and Linux, the real
background-schedule test on both, the installer checks, the dashboard's
browser tests in Chrome and Firefox, and the full rehearsal. Releases are covered in [Releasing](releasing.md).
