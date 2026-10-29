# How it works

```
 Each machine                                Your Cloudflare account
┌──────────────────────────────────┐         ┌─────────────────────────────────────┐
│ background sync (15/30/60 min)   │  HTTPS  │ Worker "ccunified"                  │
│  └─ ccunified sync               │ ──────▶ │  ├─ /agent/*  machines (upload key) │
│      └─ bundled ccusage          │  daily  │  ├─ /api/*    people (login)        │
│          └─ coding tools' logs   │  totals │  └─ /         the dashboard pages   │
└──────────────────────────────────┘         │ D1 database "ccunified"             │
                                             └─────────────────────────────────────┘
                                                ▲ https://usage.example.com
                                                │
                                             your browser
```

## The parts

| Part | Built with | Role |
|---|---|---|
| **`ccunified`**, the program on each machine | Go | Setup wizard, syncing, status, updates, and the `server` commands. One self-contained program per system |
| **ccusage** | Rust (MIT, by the ccusage authors) | Reads the logs of Claude Code and the other coding tools it supports, and totals tokens and estimated cost per day, tool and model. Shipped inside every release at a pinned version |
| **The Worker** | TypeScript, Hono, Zod | Runs on Cloudflare: takes uploads, handles logins and serves the dashboard |
| **The dashboard** | TypeScript, Vite, hand-drawn SVG charts | The web pages. Bundled into the Worker, so the dashboard is a single upload |
| **D1** | Cloudflare's SQLite database | Stores usage, machines, users, sessions and settings |

The Worker and dashboard are built at release time and packed inside
`ccunified`, which uploads them through Cloudflare's API during setup and
`ccunified server update`. That's why no machine ever needs Node.js, npm or
Wrangler, the first one included.

### Why these choices

- **Go** builds a small, self-contained program for Windows and Linux from one
  command, so machines need nothing pre-installed. Node.js would have to be
  installed everywhere; Bun-compiled programs were 70–96 MB; Python isn't on
  Windows by default; PowerShell is Windows-only.
- **ccusage v20** is a native program (about 5 MB) that doesn't need Node.js,
  it's what people already use to read Claude Code's logs, and it reads 17
  other coding tools' logs too.
- **A Cloudflare Worker with D1** costs nothing at this scale, needs no server
  to maintain, and gives each user a dashboard on their own account.
- **The upload format** is one JSON Schema in [`schema/`](../schema/), with
  shared example uploads that both the Go and TypeScript tests check, so the
  two sides can't drift apart.

## Creating a dashboard

`ccunified setup` → *Create a new dashboard*, with a Cloudflare API token:

1. Checks the token, then lists the account's Active domains and checks that
   the chosen subdomain has no DNS record yet.
2. Creates the D1 database and applies the migrations.
3. Saves the time zone and creates the admin account (the password is turned
   into a login key locally, as a browser would; see
   [Security](security.md#passwords)).
4. Uploads the Worker with the database bound to it, turns off its
   `workers.dev` address, and attaches the subdomain as a Workers custom
   domain. Cloudflare creates the DNS record and certificate.
5. Registers the machine directly in the database and gives it an upload key.
6. Waits until Cloudflare's public DNS has the new hostname, then until the
   dashboard answers (up to 15 minutes in all).
7. Saves the machine's settings, sets up the background sync and uploads the
   machine's history.

If a step fails, the wizard offers to delete what it created.

## Joining a dashboard

Joining uses a device-code flow, like signing in to a TV app:

1. The machine calls `POST /agent/pair/start` with its name, system and
   interval. It gets back a short **user code** to show (`K7QX-82MD`) and a
   long secret **device code** to keep.
2. An admin types the user code on the dashboard's Approvals page, which calls
   `POST /api/pairing/approve` and marks the request approved.
3. Meanwhile the machine calls `POST /agent/pair/poll` with its device code
   every 5 seconds. The first poll after approval creates the machine and
   returns its upload key, exactly once.

With an **enrollment key** (`ccunified setup --enroll-key`), there's no code
to show and nobody waits at the machine:

1. The machine calls `POST /agent/enroll` with the key, its name, system and
   interval. The request takes the key's department and owner, and its name
   gets a number if another machine (or another waiting one) has it. It
   returns a device code, which the machine saves in `pending.json`.
2. An admin, or a manager of the key's department, approves it on the
   Approvals page (`POST /api/pairing/decide`, many at once). Requests wait up
   to 30 days.
3. Each sync on the machine polls once (`POST /agent/pair/poll`). The first
   after approval saves the upload key, and the sync goes on to upload the
   whole history. The key is handed over only once, so it's written to
   `pending.json` before `config.json`: if saving the settings fails, the
   next sync finishes from there.

Running `ccunified setup --enroll-key` again asks the dashboard about the
waiting request (holding the sync lock, so it and a scheduled sync never
claim the key at once). It asks to join anew only if the request was denied
or expired; if the dashboard can't be asked, it says so and changes nothing.

Set up for every account on a computer (as root or SYSTEM), setup checks the
key (`POST /agent/enroll/check`, which doesn't use it up) and installs one
background sync for the computer: `ccunified sync --all-users`. That lists
the people's accounts and runs one `ccunified sync` per account, with the
account's own settings folder and its home folders in the environment so that
ccusage reads that account's logs (on Linux, as that account). An account
with usage and no settings yet enrolls as `HOST (account)`.

## Syncing

The background sync runs `ccunified sync --quiet` on schedule:

1. Takes a lock (`sync.lock`, holding the sync's process id) so two syncs
   never overlap; a lock whose process has ended (on Linux and macOS) or that
   is older than 30 minutes is considered abandoned.
2. Runs the bundled ccusage after checking its SHA-256:

   ```
   ccusage daily --json --by-agent --timezone <dashboard time zone> [--since <date>]
   ```

   This reports every tool ccusage finds on the machine. If ccusage can't
   download current prices, it's run again with its built-in prices
   (`--offline`). If it can't read the tools at all, the sync falls back to
   Claude Code alone (`ccusage claude daily …`), says so in `ccunified
   status`, and tries every tool again on the next sync. All of these runs
   share one 5-minute limit; once it's reached, the sync stops.
3. **Chooses what to send.** The first sync, the first after the dashboard's
   time zone changes, and the first in a newer upload format (see below)
   send the whole history still on disk. Later syncs send the last 7 days,
   or every day since the last successful sync if that's longer ago (more
   than 100 days: the whole history again), so usage from while the machine
   was off or offline is filled in.
4. **Uploads** to `POST /agent/ingest` in pieces of at most 100 days (and well
   under the 256 KiB limit), authenticated with the machine's upload key.
   Each upload lists the tools it covers, and each tool is covered only from
   its first day with usage in what was read: days whose logs the tool has
   since deleted are never cleared, so the dashboard keeps them. A day with
   more than 50 models keeps its 49 largest, and the rest are added up as
   one `other-models` entry (`ccunified status` notes it).
5. **The Worker replaces** that machine's rows for the uploaded days, for the
   tools the upload covers, in one transaction. Rows that didn't change
   aren't rewritten, so sending the same day again never counts it twice and
   costs almost no database writes.
6. **The reply** carries the dashboard's time zone, the upload formats it
   accepts and the newest released version (see
   [Checking for updates](#checking-for-updates)). If the machine used an
   outdated time zone,
   the Worker refuses the upload (`409 timezone_mismatch`); the machine
   switches to the new zone and uploads its whole history again.
7. Failed uploads are retried up to 6 times, waiting 1, 2, 4, 8 and 16 seconds
   (or as long as the dashboard asks, up to a minute; if it asks for longer,
   the next scheduled sync tries again). The result goes to `state.json`,
   shown by `ccunified status`, and a line to `ccunified.log`, also when the
   sync couldn't start (another sync running, ccusage missing, the dashboard
   unreachable while waiting for approval). Setting up the machine again
   starts `state.json` afresh, so the new machine uploads its whole history.

8. **Prices**, at most once a day: after a successful sync, the machine asks
   the dashboard which models it has seen (`POST /agent/prices`), downloads
   the public price lists (models.dev and LiteLLM, kept for a day in its
   settings folder), and sends each model's price from its maker. The
   dashboard keeps each machine's prices separately and uses, for each model
   and list, the price most machines report (on a tie, the one reported
   first); a revoked machine's prices stop counting. These are used only if
   an admin picks the price lists or custom prices (see
   [Prices](dashboard.md#prices)); a problem here never fails a sync.

Claude Code deletes old session logs (after 30 days by default), and other
tools may too. The dashboard keeps every day it has received, so from the day
a machine joins its history is kept for good.

### Upload formats

The upload format is defined once, in
[`schema/ingest.schema.json`](../schema/ingest.schema.json):

- **Format 2** (ccunified 0.2 and later) carries every tool ccusage reads.
  Each upload lists the tools it covers (`sources`: every tool the pinned
  ccusage looks for, whether or not it found any usage), and each day's
  entry names its tool by ccusage's id (`claude`, `codex`, `gemini`,
  `copilot`, `opencode`, …).
- **Format 1** (ccunified 0.1) carries Claude Code only. Dashboards still
  accept it, so machines can be updated in any order.

A machine asks `GET /healthz` which formats the dashboard accepts the first
time it syncs, and every upload's reply says so again. A dashboard from
ccunified 0.1 accepts format 1 only, so the machine uploads Claude Code's
usage and `ccunified status` suggests `ccunified server update`. As soon as a
reply says the dashboard accepts format 2, the machine uploads its whole
history again, with every tool, in the same sync.

### Checking for updates

The dashboard asks GitHub for the newest release (pre-releases don't count)
at most every 6 hours, in the background of a request once the last check
is older than that, and right away when someone clicks **Check for updates**
on the Settings page. It asks GitHub's API first and, if that fails (the API
limits addresses that many sites share, such as Cloudflare's), the
`releases/latest` page, which redirects to the newest release. It records
when it asked and, if neither answered, why; Settings shows both. The
versions machines report don't change it.

### The background schedule

- **Windows:** a Task Scheduler task for your user, `ccunified sync (<user>)`,
  running every N minutes and at sign-in, and catching up when the computer
  wakes. It runs `ccunifiedw.exe`, a windowless build of the same program
  (like `pythonw.exe`), so no console window flashes up.
- **Linux:** a systemd user timer, `ccunified-sync.timer`, with `Persistent=true`
  so runs missed while the machine was off happen at the next boot. Setup
  offers to turn on *lingering* so it also runs while you're logged out.
  Without systemd, a crontab line marked `# ccunified-sync` is used instead.
- **For every account:** the Task Scheduler task `ccunified sync (all users)`,
  running as SYSTEM every N minutes and at startup; on Linux, a systemd timer
  of the system (not a user's), or `/etc/cron.d/ccunified`, running as root.

## The Worker's API

**For machines** (with an upload key, except when joining):

| Endpoint | Purpose |
|---|---|
| `POST /agent/pair/start` | Ask to join; returns the user code and device code |
| `POST /agent/pair/poll` | Wait for approval; returns the upload key once |
| `POST /agent/enroll` | Ask to join with an enrollment key; returns the machine's name and a device code |
| `POST /agent/enroll/check` | Check that an enrollment key works, without using it |
| `POST /agent/ingest` | Upload usage |
| `POST /agent/prices` | Send models' prices from the public price lists; answers with the models the dashboard has seen |

**For people** (logged in, except for logging in itself):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /api/login-params`, `POST /api/login`, `POST /api/logout` | Log in (with the salt the browser needs to derive the login key) and out | anyone |
| `GET /api/me`, `POST /api/me/password` | Who's logged in; change your password | any user |
| `POST /api/me/2fa/setup`, `…/enable`, `…/disable`, `…/recovery-codes` | Two-factor login | any user |
| `GET /api/summary?days=N`, `?from=&to=` or `?all=1` | Usage per day by machine, by model and by tool, and each machine's usage per tool; `all=1` starts at the first day with usage. With `detail=1`, the rows themselves instead (day, machine, tool, model), which the Overview totals and filters in the browser; over 92 days they are summed per week, and over two years per month, as the chart shows them | any user, for the machines they see |
| `GET /api/usage-days?from=&to=` | The days in a range that have any usage (for the date picker), optionally only for some machines, tools and models (repeated `machine`, `source`, `model`) | any user, for the machines they see |
| `GET /api/machines` | The machines the user sees: status, tools, department, owner, and whether the user manages each; removed machines whose usage was kept are marked `removed_at` | any user |
| `PATCH /api/machines/:id`, `POST /api/machines/:id/revoke` | Rename, move to another department, change the owner; revoke | admin; manager of its department |
| `DELETE /api/machines/:id?usage=keep` or `?usage=delete` | Remove a revoked machine, keeping its usage in the totals or deleting it | admin; manager of its department |
| `GET /api/departments` | Departments with their numbers of machines and people (all, or those the user has a role or a machine in) | any user |
| `POST /api/departments`, `PATCH/DELETE /api/departments/:id` | Add, rename, delete departments | admin |
| `GET /api/pairing` | Machines waiting to join | admin; manager (those enrolled into their departments) |
| `POST /api/pairing/approve`, `POST /api/pairing/deny` | Approve (with a department and owner) or deny a code | admin; manager, into their departments |
| `POST /api/pairing/decide` | Approve or deny machines that enrolled with a key, many at once | admin; manager of their departments |
| `GET /api/enrollment-keys`, `POST /api/enrollment-keys`, `DELETE /api/enrollment-keys/:id` | List, create (shown once) and revoke enrollment keys | admin; manager, for their departments |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | Manage users and their roles | admin; manager, for the plain users of their departments |
| `GET /api/settings` / `PATCH /api/settings` | Read the settings and update status / change the time zone | admin or viewer / admin |
| `POST /api/settings/check-updates` | Ask GitHub for the newest release now | admin or viewer |
| `GET /api/prices` / `PATCH /api/prices` | How costs are worked out and every model's prices / choose the pricing and set custom prices | admin or viewer / admin |

Who sees and manages what is decided in the Worker
([`auth/access.ts`](../worker/src/auth/access.ts)), so each person only ever
receives the rows they may see.

`GET /healthz` answers `{"ok":true,"version":"…","schema_versions":[1,2]}`
without a login. Every other path serves the dashboard's pages.

## The database

| Table | Holds |
|---|---|
| `settings` | Time zone, a random install ID (part of the password salt), the latest known release and the outcome of the last check for one, and the tools and models seen so far in the order each first appeared (the order of their chart colors; at most 100 tools and 1,000 models, and at most 20 and 100 new ones per upload) |
| `users` | Username, dashboard-wide role (admin, viewer or none), password hash, two-factor secret, whether a new password is required, status |
| `departments` | Name |
| `department_roles` | Each person's role in a department: manager, viewer or member |
| `recovery_codes` | Two-factor recovery codes, as hashes |
| `sessions` | Login sessions, as hashes of their tokens |
| `login_attempts` | Failed-login counters for rate limiting |
| `machines` | Name, system, versions, interval, hash of the upload key, last upload, revoked time, removed time (when it was removed and its usage kept), the tools it has reported, department and owner |
| `pairing_requests` | Machines waiting to join, and the outcome of each request (with the department and owner picked when approving, and the enrollment key it came with) |
| `enrollment_keys` | Name, hash of the key, department and owner it gives, who made it, when it expires, how many machines it may add and has added, when it was last used and revoked |
| `usage_daily` | One row per machine, tool (`source`), day and model: four token counts and the estimated cost (ccusage's) |
| `model_prices` | Each model's price per million tokens from models.dev, LiteLLM (the price most machines report) and the admins (`custom`), with the list entry it came from |
| `model_price_reports` | Each machine's prices from models.dev and LiteLLM, and since when it has reported each |

All tables are SQLite `STRICT` tables, created by the migrations in
[`worker/migrations/`](../worker/migrations/); `ccunified server update`
applies new ones before uploading the new Worker.
Nothing about a particular install lives in the Worker's code, so every
dashboard runs the same Worker.

## Limits and cost

Everything fits Cloudflare's free plan. Measured with 10 machines and a year
of their usage:

- **Requests:** 10 machines uploading every 15 minutes make under 1,000
  requests a day; the free plan allows 100,000.
- **Storage:** a year of data for 10 machines is about 15,000 rows, about
  4 MB; the free plan allows 5 GB.
- **Database reads:** an upload reads about 150 rows. The Overview reads one
  row per day, machine, tool and model in the period (about 1,200 for 30
  days), and about twice that when it sums a long period per week or month
  (about 29,000 for a year). Unchanged data costs a handful of rows, as the
  dashboard asks with an ETag and gets "not modified". It refreshes every
  minute up to 92 days and every 10 minutes beyond, so even a tab left open
  on a year all day stays well under the free plan's 5 million rows a day.
- **CPU:** the free plan allows about 10 ms per request. Password stretching
  happens in the browser, and so does totaling and filtering the Overview's
  rows; over 92 days the Worker sends them per week or month, so a year takes
  about 5 ms.

## Not yet

Ideas for later versions:

- **macOS**, with a launchd schedule.
- **An account-wide 5-hour usage window**, combining ccusage's block data from
  every machine. Claude Code's own `/usage` would stay the authoritative number.
- **Syncing right after each Claude Code session**, using a Claude Code hook.
- **Alerts** for silent machines or unusual spikes.
- **CSV export.**
- **Signed releases.**
