# ccunified: project plan

A small program on each of your machines reads Claude Code's local usage logs
using ccusage. Every 30 minutes it sends daily token totals to a Cloudflare
Worker on your domain, and the Worker shows all machines on one dashboard
page behind a login.

Status: **plan only. Nothing is built yet.** Step 0 (your decisions) comes first.

---

## 1. Architecture

```
 Each machine (Windows / macOS / Linux)          Cloudflare, on your domain
 ┌────────────────────────────────┐              ┌──────────────────────────────────────┐
 │ OS scheduler, every 30 min     │              │ usage.yourdomain.com                 │
 │   └─ ccunified sync            │   HTTPS      │ Worker (TypeScript)                  │
 │        ├─ runs ccusage         │──POST───────▶│  ├─ /agent/*  machines (own token)   │
 │        │  (pinned version)     │  daily       │  ├─ /api/*    dashboard data         │
 │        └─ reads ~/.claude logs │  totals per  │  └─ /         dashboard page         │
 │                                │  model       │ D1 database (SQLite)                 │
 └────────────────────────────────┘              │ Cloudflare Access login in front of  │
                                                 │ everything except /agent/*           │
                                                 └──────────────────────────────────────┘
```

Machines only send data out; nothing connects in to them. They send totals,
not log files.

---

## 2. Languages

| Part | Language | Why |
|---|---|---|
| Machine agent | **Go** | Builds into one small program for every OS with nothing else to install |
| Cloudflare Worker | **TypeScript** | Workers run JavaScript natively; TypeScript is fully supported there |
| Dashboard page | **TypeScript + HTML/CSS** | Runs in the browser; no framework needed for one page |

### Why Go for the agent

Checked in this session:

- **ccusage v20 no longer needs Node.js.** The npm package is now only a
  wrapper around a native program written in Rust, about 5 MB. It is
  published for all six targets: Windows, macOS and Linux, each on x64 and
  ARM64. I ran the Linux build on its own against sample Claude logs and it
  produced the expected JSON. It is MIT-licensed, so we can ship it
  alongside our agent.
- So the agent is the only part that could force a runtime onto your
  machines. Go removes that. One build command produces all six programs,
  about 8 MB each. No special toolchains are needed, unlike building Rust
  for macOS from Linux.
- Go's standard library covers everything the agent does: HTTP requests,
  JSON, config files and running ccusage.

Rejected options:

- **TypeScript on Node.js on every machine.** You would have to install
  Node everywhere just for our agent, now that ccusage itself doesn't need it.
- **TypeScript compiled with Bun into one executable.** I tested this and it
  works, but each program is 70–96 MB, against about 8 MB for Go.
- **Python.** It isn't installed on Windows by default, and packaging it as
  a single program is clumsy.
- **PowerShell.** Windows only.
- **Rust.** Produces the smallest programs, but it's slower to write and
  harder to build for macOS.

Two languages mean the data format sent from machine to Worker is defined in
two places. To keep them in sync, one JSON Schema file plus shared example
payloads are tested by both the Go tests and the TypeScript tests.

---

## 3. Repository layout

```
agent/       Go: the `ccunified` command (enroll, sync, status, uninstall)
worker/      TypeScript: Cloudflare Worker, D1 migrations, wrangler config
dashboard/   TypeScript: the web page (built with Vite, served by the Worker)
schema/      payload JSON Schema + example payloads used by both test suites
scripts/     build: fetch pinned ccusage programs, cross-compile, checksums
docs/        setup runbook, Cloudflare Access steps
.github/     CI: tests on Linux, macOS and Windows; builds; deploy
```

---

## 4. How each part works

### 4.1 Agent: `ccunified`

| Command | What it does |
|---|---|
| `ccunified enroll <code>` | Trades a one-time code for this machine's token, saves config, sets up the scheduler, then runs a first sync that uploads all history on disk |
| `ccunified sync` | What the scheduler runs. Calls `ccusage claude daily --json --timezone <tz> --since <7 days ago>`, converts the result and sends it, retrying if the network fails |
| `ccunified status` | Shows server, machine name, last sync time and result, and scheduler state |
| `ccunified uninstall` | Removes the scheduler entry, config, logs and program files |

- **Install location:** a folder in your user account, so no admin rights or
  sudo are needed. The ccusage program sits next to the agent.
- **ccusage version:** pinned to an exact version (20.0.31 to start). The
  agent checks ccusage's checksum before every run, and it never uses
  `@latest`. Upgrading ccusage means releasing a new agent.
- **Config:** stored in the standard place for each OS, and only your user
  account can read it:
  - Windows: `%APPDATA%\ccunified\`
  - macOS: `~/Library/Application Support/ccunified/`
  - Linux: `~/.config/ccunified/`
- **Scheduling:** every 30 minutes. If the machine was asleep, the missed run
  happens when it wakes.
  - Windows: Task Scheduler, running hidden so no console window flashes up.
  - macOS: launchd.
  - Linux: systemd user timer, falling back to cron where systemd isn't
    available.
- **Sync window:** the first sync sends everything. Each later sync re-sends
  the last 7 days. Sending a day twice never counts it twice, and if a
  machine misses some runs, the next one fills the gap.
- **Logging:** a small log file that rotates, so `status` and troubleshooting
  have something to show.

### 4.2 Worker and D1 database

Machine endpoints live under `/agent/*`. They are not behind the Access login
and use per-machine tokens instead.

| Endpoint | Purpose |
|---|---|
| `GET /agent/install.ps1`, `GET /agent/install.sh` | One-line installers |
| `GET /agent/download/<os>-<arch>` | Agent and ccusage programs |
| `POST /agent/enroll` | One-time code in, machine token out |
| `POST /agent/ingest` | Usage upload; the reply includes the reporting timezone |

Dashboard endpoints live under `/api/*`. They are behind the Access login, and
the Worker also checks the login token itself.

| Endpoint | Purpose |
|---|---|
| `GET /api/summary?from=&to=` | Totals by day × machine × model |
| `GET /api/machines` | Machine list with health info |
| `POST /api/machines` | Add a machine; returns a one-time enrollment code |
| `PATCH /api/machines/:id`, `DELETE /api/machines/:id` | Rename or revoke a machine |

Tables:

```sql
machines (id, name, os, arch, agent_version, ccusage_version,
          token_hash, created_at, last_seen_at, last_error, revoked_at)

enrollment_codes (code_hash, machine_id, expires_at, used_at)

usage_daily (machine_id, source, day, model,
             input_tokens, output_tokens,
             cache_creation_tokens, cache_read_tokens,
             cost_usd, updated_at,
             PRIMARY KEY (machine_id, source, day, model))
```

- `source` is `claude` for now. It leaves room to add Codex, Gemini CLI and
  other tools ccusage reads, without changing the database.
- **How uploads are saved:** each upload replaces the stored rows for every
  machine and day it contains, all at once. Rows that haven't changed are not
  rewritten, which keeps database writes near zero.
- **One timezone for every machine:** you set it once at deploy, and the
  Worker sends it to agents with each upload reply. That way every machine
  agrees where a day starts and ends. If you change it, agents re-upload
  their history in the new timezone.

### 4.3 Dashboard

- **Top row:** tokens for today, 7 days and 30 days; estimated cost at API
  prices; how many machines are reporting.
- **Daily chart:** stacked bars, switchable between per machine and per model.
- **Machines table:** last seen (flagged if silent for more than 2 hours), OS,
  agent version, 7- and 30-day totals, and rename or revoke buttons.
- **Model breakdown.**
- **Controls:** date range (7, 30 or 90 days, or all), refreshing every 60
  seconds.
- **Add machine:** shows a one-line install command for each OS, with a code
  that works once and expires after 15 minutes:

  ```powershell
  # Windows (PowerShell)
  & ([scriptblock]::Create((irm https://usage.yourdomain.com/agent/install.ps1))) -Code K7QX-82MD
  ```
  ```sh
  # macOS / Linux
  curl -fsSL https://usage.yourdomain.com/agent/install.sh | sh -s -- K7QX-82MD
  ```
- Works in light and dark mode, and on a phone.

---

## 5. Security

- **Dashboard login:** the dashboard and `/api/*` sit behind Cloudflare
  Access, which emails a one-time PIN. It's free for up to 50 users. The
  Worker also checks the Access login token itself, so if the Access rule is
  misconfigured, the dashboard stays locked rather than open.
- **The `*.workers.dev` address is turned off.** Every Worker gets one by
  default, and it would get around the Access login.
- **Machine tokens:** each machine has its own token, stored only as a hash.
  You can revoke one lost laptop without touching the others. The token
  decides which machine the data belongs to, so one machine can't write
  another's data.
- **What leaves a machine:** day, model, the four token counts, estimated
  cost, and agent and OS version. No prompts, file paths or project names.
- **Upload checks:** every upload is checked against the expected format and
  size before it's stored.
- **Pinned ccusage:** the version is fixed and its checksum is verified, so
  nothing is downloaded and run unattended.

---

## 6. Steps

| # | Step | Who | Done when |
|---|---|---|---|
| 0 | Answer the open questions (§9) | you | answers given |
| 1 | Set up the repo: layout, linting, test runners, CI on Linux, macOS and Windows | me | CI passes on the empty skeleton |
| 2 | Payload schema and example payloads | me | the same examples pass in the Go and TypeScript tests |
| 3 | Worker and D1: tables, enroll, upload, summary and machines endpoints, login checks | me | tests pass against a local D1 database running inside Cloudflare's runtime |
| 4 | Agent core: config, running ccusage, building the upload, enroll/sync/status, retries | me | tests pass using fake Claude logs and the real ccusage program |
| 5 | Scheduling and packaging: scheduler on 3 OSes, 6 builds, install scripts | me | CI installs, runs and removes the scheduled job on real Windows, macOS and Linux test machines |
| 6 | Dashboard page | me | it shows the example data correctly; reviewed by screenshot |
| 7 | Full local run: local Worker, real agent and a browser test | me | the agent's upload appears on the dashboard |
| 8 | Deploy to your Cloudflare account: database, Worker, subdomain, Access login | you + me (runbook) | dashboard loads at your subdomain after login |
| 9 | Install on each machine with the one-line command | you | every machine shows "last seen" under 30 minutes ago |

- **Steps 1–7** can all be done in this cloud session. I can't run Windows or
  macOS here, but GitHub Actions has Windows and macOS test machines, so CI
  checks those for real.
- **Steps 8–9** need your Cloudflare account and your machines.
- Each step lands as its own commits on this branch, so you can review as it
  goes.

**Deploying (step 8).** Two options:

- **Automatic (recommended):** create a Cloudflare API token limited to
  Workers and D1, and save it as a GitHub secret. GitHub Actions then
  deploys every time `main` changes.
- **Manual:** run `npx wrangler login` and `npm run deploy` from your own
  computer.

Either way, the Access login is a one-time manual setup in the Cloudflare Zero
Trust dashboard, about 5 minutes. `docs/` will have the exact clicks.

---

## 7. Tools

| Area | Tool | Role |
|---|---|---|
| Agent | Go 1.24+ (standard library only) | One program per OS, nothing else to install |
| Agent | ccusage 20.0.31 native programs (MIT) | Reads the Claude Code logs |
| Cloudflare | Wrangler CLI | Deploy, database setup, running locally |
| Cloudflare | Workers + Static Assets, D1, Access | Hosting, database, login |
| Worker | Hono | Small routing library made for Workers |
| Worker | Zod | Checks incoming uploads |
| Worker | jose | Verifies Cloudflare Access login tokens |
| Dashboard | Vite | Builds the page |
| Dashboard | Chart.js | Charts |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Worker tests inside the real Workers runtime |
| Tests | `go test` | Agent tests |
| Tests | Playwright | End-to-end browser check |
| Quality | Biome (TypeScript), gofmt + go vet (Go) | Formatting and linting |
| CI/CD | GitHub Actions | Tests on 3 OSes, builds, deploy |

**What needs to be installed:**

- **Your machines:** nothing beforehand. The one-line installer does it all,
  with no admin rights.
- **Your own computer:** nothing, if you use the automatic deploy.

---

## 8. Cost

Everything fits Cloudflare's free plan.

- **Requests:** 10 machines syncing every 30 minutes is about 480 requests a
  day. The free limit is 100,000.
- **Storage:** a year of data for 10 machines with about 4 models each is
  around 15,000 rows, a few MB. The free limit is 5 GB.

---

## 9. Open questions (step 0)

1. **Machines:** which OSes do they run, and are any ARM (e.g. Apple Silicon
   Macs, Snapdragon PCs)? All six builds are planned either way; this decides
   what gets tested first.
2. **Address:** your domain, and the subdomain for the dashboard (e.g.
   `usage.yourdomain.com`).
3. **Timezone:** which timezone the dashboard's days should use.
4. **What to track:** only Claude Code at first, or also other tools ccusage
   reads (Codex, Gemini CLI, Copilot CLI and others)? Recommendation: Claude
   Code first; adding others later is a small change.
5. **Deploying:** automatic through GitHub Actions (recommended), or from
   your own computer?
6. **Access:** which email addresses may open the dashboard?

---

## 10. Later (not in the first version)

- **Account-wide 5-hour window view.** Plan limits apply to your whole
  account, but each machine only sees its own usage. Combining ccusage's
  5-hour block data from every machine would give a combined estimate.
  Claude Code's `/usage` stays the authoritative number.
- **Other AI coding tools**, using the `source` column.
- **Agent self-update.**
- **Sync right after each Claude Code session ends**, using a Claude Code hook.
- **Alerts** (machine silent for a day, unusual spike) from a Worker on a timer.
- **CSV export.**

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| A future ccusage changes its JSON output | Version is pinned; example-based tests catch it before we upgrade |
| Claude Code changes its log format | ccusage usually updates quickly; we raise the pin after tests pass |
| Claude Code deletes local logs after 30 days by default | The first sync uploads everything; from then on the dashboard keeps the history |
| Windows hidden scheduled task behaves differently on real hardware | Tested on GitHub's Windows test machines in CI before release |
| Unsigned programs may trigger SmartScreen or Gatekeeper warnings | The installers download with PowerShell or curl, which normally don't trigger them; code signing is out of scope |
| Cost figures get mistaken for real charges | Labelled "API-price estimate"; subscriptions aren't billed per token |
