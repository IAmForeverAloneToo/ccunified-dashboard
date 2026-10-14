# How it works

```
 Each machine                                Your Cloudflare account
┌──────────────────────────────────┐         ┌─────────────────────────────────────┐
│ background sync (15/30/60 min)   │  HTTPS  │ Worker "ccunified"                  │
│  └─ ccunified sync               │ ──────▶ │  ├─ /agent/*  machines (upload key) │
│      └─ bundled ccusage          │  daily  │  ├─ /api/*    people (login)        │
│          └─ Claude Code's logs   │  totals │  └─ /         the dashboard pages   │
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
| **ccusage** | Rust (MIT, by the ccusage authors) | Reads Claude Code's logs and totals tokens and estimated cost per day and model. Shipped inside every release at a pinned version |
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
  and it's what people already use to read Claude Code's logs.
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

## Syncing

The background sync runs `ccunified sync --quiet` on schedule:

1. Takes a lock (`sync.lock`) so two syncs never overlap; a lock older than 30
   minutes is considered abandoned.
2. Runs the bundled ccusage after checking its SHA-256:

   ```
   ccusage claude daily --json --timezone <dashboard time zone> [--since <date>]
   ```

   If ccusage can't download current prices, it's run again with its built-in
   prices (`--offline`).
3. **Chooses what to send.** The first sync, and the first after the
   dashboard's time zone changes, sends the whole history still on disk.
   Later syncs send the last 7 days, which also fills in anything missed while
   the machine was off.
4. **Uploads** to `POST /agent/ingest` in pieces of at most 100 days (and well
   under the 256 KiB limit), authenticated with the machine's upload key.
5. **The Worker replaces** that machine's rows for the uploaded days in one
   transaction. Rows that didn't change aren't rewritten, so sending the same
   day again never counts it twice and costs almost no database writes.
6. **The reply** carries the dashboard's time zone and the newest released
   version. The dashboard asks GitHub for that every 6 hours, and learns it
   sooner when a machine uploads with a newer release than it knows of. If the machine used an outdated time zone, the Worker refuses the
   upload (`409 timezone_mismatch`); the machine switches to the new zone and
   uploads its whole history again.
7. Failed uploads are retried up to 6 times, waiting 1, 2, 4, 8 and 16 seconds
   (or as long as the dashboard asks). The result goes to `state.json`, shown
   by `ccunified status`, and a line to `ccunified.log`.

Claude Code deletes old session logs (after 30 days by default). The dashboard
keeps every day it has received, so from the day a machine joins its history
is kept for good.

### The background schedule

- **Windows:** a Task Scheduler task for your user, `ccunified sync (<user>)`,
  running every N minutes and at sign-in, and catching up when the computer
  wakes. It runs `ccunifiedw.exe`, a windowless build of the same program
  (like `pythonw.exe`), so no console window flashes up.
- **Linux:** a systemd user timer, `ccunified-sync.timer`, with `Persistent=true`
  so runs missed while the machine was off happen at the next boot. Setup
  offers to turn on *lingering* so it also runs while you're logged out.
  Without systemd, a crontab line marked `# ccunified-sync` is used instead.

## The Worker's API

**For machines** (with an upload key, except when joining):

| Endpoint | Purpose |
|---|---|
| `POST /agent/pair/start` | Ask to join; returns the user code and device code |
| `POST /agent/pair/poll` | Wait for approval; returns the upload key once |
| `POST /agent/ingest` | Upload usage |

**For people** (logged in, except for logging in itself):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /api/login-params`, `POST /api/login`, `POST /api/logout` | Log in (with the salt the browser needs to derive the login key) and out | anyone |
| `GET /api/me`, `POST /api/me/password` | Who's logged in; change your password | any user |
| `POST /api/me/2fa/setup`, `…/enable`, `…/disable`, `…/recovery-codes` | Two-factor login | any user |
| `GET /api/summary?days=N` or `?from=&to=` | Usage per day by machine and by model | viewer |
| `GET /api/usage-days?from=&to=` | The days in a range that have any usage (for the date picker) | viewer |
| `GET /api/machines` | Machines and their status | viewer |
| `PATCH /api/machines/:id`, `DELETE /api/machines/:id` | Rename, revoke | admin |
| `GET /api/pairing`, `POST /api/pairing/approve`, `POST /api/pairing/deny` | Machines waiting to join | admin |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | Manage users | admin |
| `GET /api/settings` / `PATCH /api/settings` | Read / change the time zone | viewer / admin |

`GET /healthz` answers `{"ok":true,"version":"…"}` without a login. Every other
path serves the dashboard's pages.

## The database

| Table | Holds |
|---|---|
| `settings` | Time zone, a random install ID (part of the password salt), the latest known release |
| `users` | Username, role (admin or viewer), password hash, two-factor secret, whether a new password is required, status |
| `recovery_codes` | Two-factor recovery codes, as hashes |
| `sessions` | Login sessions, as hashes of their tokens |
| `login_attempts` | Failed-login counters for rate limiting |
| `machines` | Name, system, versions, interval, hash of the upload key, last upload, revoked time |
| `pairing_requests` | Machines waiting to join, and the outcome of each request |
| `usage_daily` | One row per machine, source, day and model: four token counts and the estimated cost |

All tables are SQLite `STRICT` tables, created by the migrations in
[`worker/migrations/`](../worker/migrations/). The `source` column is `claude`
for now, leaving room for other coding tools without changing the tables.
Nothing about a particular install lives in the Worker's code, so every
dashboard runs the same Worker.

## Limits and cost

Everything fits Cloudflare's free plan:

- **Requests:** 10 machines uploading every 15 minutes make under 1,000
  requests a day; the free plan allows 100,000.
- **Storage:** a year of data for 10 machines is about 15,000 rows, a few
  megabytes; the free plan allows 5 GB.
- **CPU:** the free plan allows about 10 ms per request, which is why password
  stretching happens in the browser.

## Not yet

Ideas for later versions:

- **macOS**, with a launchd schedule.
- **Other AI coding tools** (Codex, Gemini CLI and others), using the `source`
  column.
- **An account-wide 5-hour usage window**, combining ccusage's block data from
  every machine. Claude Code's own `/usage` would stay the authoritative number.
- **Syncing right after each Claude Code session**, using a Claude Code hook.
- **Alerts** for silent machines or unusual spikes.
- **CSV export.**
- **Signed releases.**
