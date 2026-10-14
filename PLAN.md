# ccunified: project plan

`ccunified` is a small program you install on each of your machines. It reads
Claude Code's local usage logs using ccusage, then uploads daily token totals
to a dashboard on your own domain, hosted on your own Cloudflare account. All
your machines appear on one page.

The repository is public and contains **no configuration and no secrets**. No
domain, account ID, email, password or key is written into the code. All of
that is entered in the setup wizard on your own machine and goes straight to
your Cloudflare account.

Status: **plan only. Nothing is built yet.**

---

## 1. Decisions so far

| Topic | Decision |
|---|---|
| Machines to support | Windows x64 and Linux x64 (Ubuntu and other distributions). The code is kept ready for macOS later |
| Tools tracked | Claude Code only for now. The database leaves room to add others later |
| Configuration | Domain, subdomain, timezone, accounts and sync interval are all chosen in the setup wizard; nothing is written into the code |
| Setup wizard | Step-by-step prompts in the terminal (also works over SSH on servers without a desktop) |
| Cloudflare setup | Done by the wizard on the first machine, using a Cloudflare API token you paste in |
| Cloudflare token | Used during setup and then discarded. Later server changes ask for it again |
| Dashboard login | Built-in username and password, checked by the Worker itself (no Cloudflare Access) |
| Accounts | Multiple users with two roles: **admin** (manages users and machines) and **viewer** (read-only) |
| Two-factor | Optional for each user, using authenticator-app codes, with recovery codes |
| Adding a machine | The new machine shows a short code; an admin approves that code in the dashboard |
| Sync interval | Chosen in setup (15, 30 or 60 minutes; default 30), changeable later with a command |
| Linux while logged out | Keeps syncing; setup may ask for your sudo password once to allow this |
| Updates | The dashboard flags out-of-date machines; you run `ccunified update` on each one when you choose |
| Program name | `ccunified` |
| Password hashing | Done in the browser (600,000 rounds of PBKDF2-SHA256), plus a quick salted hash on the Worker. Measured in step 4: Cloudflare's free plan can't do strong hashing on the server within its 10 ms CPU limit |
| Tool versions | Always the latest: Node.js 24 LTS, npm 12, Go 1.27, TypeScript 7, Vitest 5, plus the latest of every library and GitHub Action |
| License | MIT, copyright IAmForeverAloneToo |
| Git | Everything is pushed to `Main` |

---

## 2. How one dashboard works with many machines

```
 FIRST MACHINE: "Create a new dashboard"
   wizard asks for: Cloudflare API token, domain, subdomain,
                    timezone, admin username + password, sync interval
   wizard then:     creates the database, uploads the Worker,
                    attaches usage.<your-domain>, creates the admin account,
                    enrolls this machine, starts the background sync,
                    and discards the Cloudflare token

 EVERY OTHER MACHINE: "Join an existing dashboard"
   wizard asks for: dashboard address, machine name, sync interval
   machine shows:   "Approve code K7QX-82MD at https://usage.<your-domain>"
   admin:           logs in from any device, clicks Approve next to K7QX-82MD
   machine:         receives its own upload key, starts the background sync

 Each machine (every 15/30/60 min)                    Cloudflare (your account)
 ┌───────────────────────────────┐   HTTPS POST     ┌──────────────────────────────┐
 │ ccunified sync                │  daily totals    │ Worker (TypeScript)          │
 │  └─ runs bundled ccusage      │ ───────────────▶ │  ├─ /agent/*  machine keys   │
 │      └─ reads ~/.claude logs  │  per model       │  ├─ /api/*    logged-in users│
 └───────────────────────────────┘                  │  └─ /         dashboard page │
                                                    │ D1 database                  │
                                                    └──────────────────────────────┘
```

- **Where things are stored:**
  - Users, passwords and settings: in your Cloudflare D1 database.
  - Each machine: only its own upload key, which can send data but can't read
    the dashboard.
- **Upload keys:** every machine has a different one, so revoking a lost
  laptop doesn't affect the others.

---

## 3. Languages

| Part | Language | Why |
|---|---|---|
| Machine program (`ccunified`) | **Go** | One self-contained program per OS; your machines need nothing pre-installed |
| Cloudflare Worker | **TypeScript** | Workers run JavaScript natively |
| Dashboard page | **TypeScript + HTML/CSS** | Runs in the browser; no framework needed |

### Why Go for the machine program

Checked in this session:

- **ccusage v20 is a native program written in Rust, about 5 MB.** It is
  published for Windows, Linux and macOS and doesn't need Node.js. I ran it
  on its own against sample Claude logs and the output was correct. It is
  MIT-licensed, so we can ship it alongside our program.
- **Go builds a small, self-contained program for Windows and Linux from one
  build command**, with macOS a one-line addition later. Its standard library
  covers HTTP, JSON, running ccusage and calling the Cloudflare API.
- **The Worker and dashboard are built at release time and packed inside
  `ccunified`.** The setup wizard uploads them through Cloudflare's API, so
  **no machine ever needs Node.js, npm or Wrangler**, including the first one.

Rejected options:

- **TypeScript on Node.js:** Node would have to be installed on every
  machine.
- **TypeScript compiled with Bun:** I tested it and it works, but each
  program is 70–96 MB.
- **Python:** not installed on Windows by default.
- **PowerShell:** Windows only.
- **Rust:** slower to write and harder to build for every OS.

The upload format is defined once as a JSON Schema in `schema/`. Shared
example payloads are tested by both the Go tests and the TypeScript tests, so
the two sides can't drift apart.

---

## 4. Repository layout

```
agent/       Go: the ccunified program (setup wizard, sync, status, update, server commands)
worker/      TypeScript: Cloudflare Worker + D1 migrations
dashboard/   TypeScript: dashboard pages (bundled into the Worker)
schema/      upload format JSON Schema + example payloads for both test suites
scripts/     build: fetch pinned ccusage, bundle Worker, cross-compile, package
docs/        user guide, Cloudflare token instructions, troubleshooting
.github/     CI (Linux + Windows test machines) and release builds
```

---

## 5. The machine program: `ccunified`

### 5.1 Installing

Releases are published on this repository's public GitHub Releases page. The
repository must be public for these commands to work.

```powershell
# Windows (PowerShell, no admin needed)
irm https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.ps1 | iex
```
```sh
# Linux (no root needed)
curl -fsSL https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.sh | sh
```

The installer downloads the release for your OS, checks it against the
release's checksums, installs it into your user account and starts
`ccunified setup`. Install locations:

- Windows: `%LOCALAPPDATA%\Programs\ccunified\`, added to your PATH.
- Linux: `~/.local/share/ccunified/`, with a link in `~/.local/bin`.

### 5.2 Commands

| Command | What it does |
|---|---|
| `ccunified setup` | The wizard: create a new dashboard, or join an existing one |
| `ccunified sync` | What the background schedule runs; also safe to run by hand |
| `ccunified status` | Dashboard address, machine name, last sync time and result, schedule state, versions |
| `ccunified config set interval 15\|30\|60` | Change how often this machine uploads |
| `ccunified update` | Download the latest release, verify it and replace itself |
| `ccunified uninstall` | Remove the schedule, config, logs and program files from this machine |
| `ccunified server update` | Upgrade the Cloudflare side to this program's version (asks for a Cloudflare token) |
| `ccunified server reset-password <user>` | Recover a locked-out admin account (asks for a Cloudflare token) |
| `ccunified server remove` | Delete the Worker, subdomain and database from Cloudflare, after a confirmation (asks for a Cloudflare token) |

### 5.3 What the setup wizard asks

**Create a new dashboard**

1. **Cloudflare API token.** The wizard shows exactly which permissions to
   tick and links to the token page. It checks the token before continuing.
2. **Domain**, picked from the domains in your Cloudflare account.
3. **Subdomain**, e.g. `usage`, giving `usage.<your-domain>`.
4. **Timezone** for the dashboard's days. The default is this machine's
   timezone, and admins can change it later in the dashboard.
5. **Admin username and password**, which you type twice.
6. **This machine's name** (the default is its hostname) and its **sync
   interval**.
7. A **summary to confirm**. The wizard then builds everything, starts the
   background sync, runs the first upload and prints the dashboard address.
   The token is then discarded.

**Join an existing dashboard**

1. **Dashboard address.**
2. **Machine name** and **sync interval**.
3. The machine shows an approval code. An admin approves it in the
   dashboard, and the wizard continues automatically.

### 5.4 Background sync

**What each sync sends.** Each run calls the bundled ccusage like this:

```
ccusage claude daily --json --timezone <dashboard timezone> --since <7 days ago>
```

- The first sync sends all history still on disk. Claude Code deletes its
  own logs after 30 days by default, so from then on the dashboard keeps the
  long-term history.
- Later syncs re-send the last 7 days. Sending a day twice never counts it
  twice, and missed runs are filled in by the next one.
- The dashboard's timezone comes back with every upload reply, so all
  machines agree where a day starts and ends.
- A failed upload is retried with increasing waits. Each run writes a short
  line to a small log file that rotates.

**ccusage version.** ccusage is pinned to an exact version (20.0.31 to start)
and ships inside each release. Its checksum is verified before every run. It
is never downloaded as "latest" while running.

**How the schedule runs:**

- **Windows:** Task Scheduler, under your own user account. It runs a
  windowless copy of the program (`ccunifiedw.exe`, the same idea as
  `pythonw.exe`), so no console window flashes up. Missed runs happen when
  the machine wakes.
- **Linux:** a systemd user timer, with "lingering" enabled so it keeps
  running while you're logged out. Enabling that may need your sudo password
  once during setup. Where systemd isn't available, the wizard uses cron
  instead.

---

## 6. The Cloudflare side

### 6.1 Worker endpoints

**For machines** (under `/agent/*`; they use upload keys, not logins):

| Endpoint | Purpose |
|---|---|
| `POST /agent/pair/start` | A new machine asks to join and receives its approval code |
| `POST /agent/pair/poll` | The machine waits for approval, then receives its upload key |
| `POST /agent/ingest` | Upload usage; the reply includes the timezone and the latest known version |

**For people** (under `/api/*`; they need a login):

| Endpoint | Purpose | Who |
|---|---|---|
| `POST /api/login`, `POST /api/logout` | Log in and out (with an authenticator code if turned on) | anyone |
| `GET /api/summary?from=&to=` | Totals by day × machine × model | viewer, admin |
| `GET /api/machines` | Machines and how recently each reported | viewer, admin |
| `GET /api/pairing`, `POST /api/pairing/:code/approve`, `POST /api/pairing/:code/deny` | Machines waiting for approval | admin |
| `PATCH /api/machines/:id`, `DELETE /api/machines/:id` | Rename or revoke a machine | admin |
| `GET/POST/PATCH/DELETE /api/users…` | Manage users and roles | admin |
| `POST /api/me/password`, `POST /api/me/2fa…` | Change your own password and turn two-factor on or off | anyone logged in |
| `GET/PATCH /api/settings` | Timezone and other dashboard settings | admin |

### 6.2 Database tables (D1)

```sql
settings          (key PRIMARY KEY, value)                 -- timezone, schema version, ...
users             (id, username UNIQUE, password_hash, role,  -- role: admin | viewer
                   totp_secret, totp_enabled, created_at, last_login_at, disabled_at)
recovery_codes    (user_id, code_hash, used_at)
sessions          (id_hash PRIMARY KEY, user_id, created_at, expires_at, last_seen_at)
login_attempts    (key, window_start, count)               -- rate limiting
pairing_requests  (id, device_code_hash, user_code, machine_name, os, arch,
                   agent_version, created_at, expires_at, status, decided_by, machine_id)
machines          (id, name, os, arch, agent_version, ccusage_version, sync_interval,
                   token_hash, created_at, last_seen_at, last_error, revoked_at)
usage_daily       (machine_id, source, day, model,
                   input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                   cost_usd, updated_at,
                   PRIMARY KEY (machine_id, source, day, model))
```

- **`source`** is `claude` for now; Codex, Gemini CLI and others can be added
  later without changing the tables.
- **How uploads are saved:** each upload replaces that machine's rows for the
  days it contains, all at once. Rows that haven't changed are not rewritten,
  which keeps database writes near zero.
- **Nothing install-specific lives in the Worker's code.** Settings like the
  timezone live in the `settings` table, so every install runs the same
  Worker, and admins can change the settings from the dashboard.

### 6.3 Dashboard pages

- **Login**, which also asks for an authenticator code when two-factor is on.
- **Overview:**
  - Totals for today, 7 days and 30 days, with cost estimated at API prices.
  - Daily stacked bar chart, switchable between per machine and per model.
  - Model breakdown.
  - Date range (7, 30 or 90 days, or all); refreshes every 60 seconds.
- **Machines:** last seen (flagged when overdue for its own sync interval),
  OS, program version (flagged when out of date), and 7- and 30-day totals.
  Admins can rename or revoke machines.
- **Approvals** (admin): machines waiting to join, showing code, name and OS,
  with Approve and Deny buttons. The overview shows a badge when any are
  waiting.
- **Users** (admin): add a user, set their role, reset their password,
  disable them.
- **Account:** change your password, set up two-factor (QR code and recovery
  codes).
- **Settings** (admin): timezone, and the server version alongside the
  latest release.
- Works in light and dark mode, and on a phone.

---

## 7. Security

- **The repository holds no secrets or install details.** Everything
  install-specific is entered in the wizard and stored only in your
  Cloudflare account or on your machine.
- **Cloudflare token:** used only while the wizard runs, then discarded. The
  wizard asks for the fewest permissions that do the job.
- **Passwords never leave the browser.**
  - The browser stretches each password with 600,000 rounds of PBKDF2-SHA256
    (OWASP's recommendation), salted per user and per install, and sends only
    the result.
  - The Worker stores a salted hash of that result, so a stolen copy of the
    database is as slow to crack as if the server had done all 600,000
    rounds.
  - Strong hashing on the server isn't possible within the free plan's 10 ms
    CPU limit: measured, 100,000 rounds take about 17 ms.
  - Because the server never sees the password, it can't check password
    strength itself. The dashboard and the wizard require at least 10
    characters.
- **Logging in:**
  - The session cookie can't be read by scripts, is only sent over HTTPS,
    and isn't sent with requests from other sites.
  - Sessions are stored server-side, so logging out or disabling a user ends
    them immediately.
  - Repeated failed logins are slowed down and then locked out for a while.
- **Two-factor:** optional per user, using authenticator-app codes (the
  same kind Google Authenticator and 1Password produce), plus single-use
  recovery codes.
- **Roles:** checked on the server for every request, not just hidden in the
  page.
- **Pairing a new machine:**
  - The code expires after 10 minutes and can't be guessed in time.
  - Only an admin can approve it.
  - The dashboard shows the machine's name, OS and request time next to the
    code, so you can tell which machine you're approving.
  - Pending requests are rate-limited.
- **Upload keys:** one per machine, stored only as hashes and revocable one
  at a time. The key decides which machine the data belongs to.
- **Uploads:** every upload is checked against the expected format and size
  before it's stored.
- **The `*.workers.dev` address is turned off**, so the dashboard is only
  reachable at your own subdomain.
- **Browser protections:** strict security headers, including a content
  security policy and a rule against embedding the dashboard in other sites.
- **What leaves a machine:** day, model, the four token counts, estimated
  cost, and program and OS version. No prompts, file paths or project names.
- **Downloads:** every release, and every `ccunified update`, is checked
  against the release's SHA-256 checksums.

---

## 8. Steps

| # | Step | Who | Done when |
|---|---|---|---|
| 0 | Decisions (§1) | you | ✅ done |
| 1 | Repo skeleton, formatting and linting, test runners, CI on Linux and Windows test machines | me | CI passes |
| 2 | Upload format schema and example payloads | me | the same examples pass the Go and TypeScript tests |
| 3 | Worker core: tables and migrations, upload, summary, machines, settings | me | tests pass inside Cloudflare's runtime, run locally |
| 4 | Worker login: users, roles, passwords, sessions, rate limiting, two-factor, machine pairing | me | login and permission tests pass, including attack cases |
| 5 | Dashboard pages (§6.3) | me | every page works against test data; reviewed by screenshot |
| 6 | Machine program core: config, ccusage runner, upload, retries, status | me | tests pass with fake Claude logs and the real ccusage |
| 7 | Setup wizard: "create new dashboard" (Cloudflare API) and "join existing" (pairing); server update, reset-password and remove commands | me | wizard tests pass against a simulated Cloudflare API and a local Worker |
| 8 | Background schedule, install, update and uninstall on Windows and Linux | me | CI installs, runs, updates and removes it on real Windows and Linux test machines |
| 9 | Release pipeline: tag → GitHub Actions builds Windows and Linux packages (with pinned ccusage), checksums and install scripts | me | a test release installs correctly from GitHub on both OSes |
| 10 | Full rehearsal: local Worker, real program, automated browser test of the whole flow | me | setup → pairing → sync → numbers on the dashboard, all automated |
| 11 | First real setup on your Cloudflare account | you, with me fixing anything that breaks | dashboard live at your subdomain |
| 12 | Join the rest of your machines | you | every machine reporting on time |

- **Steps 1–10** I can do in this cloud session. GitHub's Windows test
  machines cover the Windows-only parts.
- **Real Cloudflare:** I can't use your Cloudflare account from here, so the
  wizard is tested against a simulated Cloudflare API. Step 11 is the first
  real run.
- **Before step 11** the repository must be public, so the install commands
  can download releases.

---

## 9. Tools

| Area | Tool | Role |
|---|---|---|
| Machine program | Go 1.27 (standard library, plus a small library for terminal prompts) | Self-contained Windows and Linux programs |
| Machine program | ccusage 20.0.31 native programs (MIT) | Reads Claude Code's logs |
| Cloudflare | Workers, D1 | Hosting and database (free plan) |
| Cloudflare | Cloudflare REST API | Used by the wizard to create everything; no Wrangler needed for users |
| Worker | Hono | Small routing library made for Workers |
| Worker | Zod | Checks every incoming request |
| Worker | Web Crypto (built into Workers) | Password hashing, tokens, two-factor codes |
| Dashboard | Vite | Builds the pages (bundled into the Worker) |
| Development only | Node.js 24 LTS + npm 12 | Builds and tests the Worker and dashboard; never needed on your machines |
| Dashboard | Chart.js | Charts |
| Development only | Wrangler | Runs the Worker locally for tests |
| Tests | Vitest + Miniflare | Worker tests inside workerd, Cloudflare's real runtime, against a real D1 database. Cloudflare's Vitest plugin doesn't support the latest Vitest yet, so Miniflare is used directly |
| Tests | `go test` | Machine program tests |
| Tests | Playwright | Automated browser test of the whole flow |
| Quality | Biome (TypeScript), gofmt + go vet (Go) | Formatting and linting |
| CI and releases | GitHub Actions + GitHub Releases | Tests on Linux and Windows, builds, publishing |

---

## 10. Cost

Everything should fit Cloudflare's free plan.

- **Requests:** 10 machines syncing every 15 minutes is under 1,000 requests
  a day. The free limit is 100,000.
- **Storage:** a year of data for 10 machines is about 15,000 rows, a few MB.
  The free limit is 5 GB.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Password hashing too slow for the free plan's 10 ms CPU limit | Resolved in step 4: hashing moved to the browser (see Security) |
| Cloudflare API token permissions or API behaviour differ from the docs | Step 11 is the real check. The wizard reports exactly which call failed and why |
| A future ccusage changes its output | Version is pinned; example-based tests catch it before any upgrade |
| Claude Code changes its log format | ccusage usually updates quickly; we raise the pin after tests pass |
| Windows Task Scheduler or Linux lingering behave differently on some machines | Tested on GitHub's Windows and Linux test machines; `ccunified status` shows whether the schedule is healthy |
| Unsigned programs may trigger a SmartScreen warning | The installers download with PowerShell or curl, which normally don't trigger it; code signing costs money and is out of scope |
| Cost figures get mistaken for real charges | Labelled "API-price estimate"; subscriptions aren't billed per token |

---

## 12. Later (not in the first version)

- **macOS support:** a launchd schedule plus macOS builds.
- **Other AI coding tools** (Codex, Gemini CLI and others), using the
  `source` column.
- **Account-wide 5-hour window view:** combine ccusage's 5-hour block data
  from every machine for an estimate. Claude Code's `/usage` stays the
  authoritative number.
- **Sync right after each Claude Code session ends**, using a Claude Code
  hook.
- **Alerts** (machine silent too long, unusual spike).
- **CSV export.**
- **Signed releases**, for stronger protection if the GitHub account were
  ever compromised.
