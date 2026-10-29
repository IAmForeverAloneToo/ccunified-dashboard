# Security and privacy

ccunified is built so that your usage data stays on infrastructure you control,
only totals leave your machines, and a leaked piece of the system (a machine's
key, a copy of the database, a Cloudflare token) does as little damage as
possible.

## What leaves your machines

Uploads go only to your own dashboard. Nothing is sent to the authors of
ccunified or anyone else.

| When | What |
|---|---|
| Joining | The machine's name, operating system, processor type, ccunified version and upload interval |
| Every upload | The same versions and settings, the ccusage version, the dashboard's time zone, the date range, the tools ccusage looked for, and for each day, tool and model: the tool (such as `codex`), the model name, the four token counts (input, output, cache writes, cache reads) and the estimated cost |

Prompts, responses, code, file paths, project names and session details never
leave the machine. ccusage reads the coding tools' logs locally, and ccunified
only sends the daily totals it calculates. The upload format is defined in
[`schema/ingest.schema.json`](../schema/ingest.schema.json); the dashboard
rejects anything that doesn't match it.

Besides your dashboard, a machine contacts GitHub (for `ccunified update` and
installs) and Cloudflare's public DNS (only when its own DNS can't find the
dashboard). ccusage downloads current model prices; if that fails, it uses the
prices built into it. Once a day ccunified downloads the same public price
lists (models.dev and LiteLLM's on GitHub) for the dashboard's own pricing,
sending them nothing. The dashboard itself asks GitHub for the newest
ccunified release every 6 hours, and when someone clicks **Check for
updates**, sending nothing but its own version.

## Where your data is stored

Everything lives on your own Cloudflare account: usage, machines, users,
sessions and settings are in a D1 database there. The repository contains no
domain, account ID, email, password or key; all of that is entered in the
setup wizard and goes straight to your Cloudflare account or stays on your
machine.

## Your Cloudflare API token

Only the commands that create or change the dashboard (`ccunified setup` when
creating one, and `ccunified server …`) use a Cloudflare token. They use it
while they run and never save it. The token page the wizard links to asks for
the fewest permissions the job needs, and you can limit the token further to
one account, one domain and a short lifetime (see
[Create your dashboard](setup.md#2-create-the-cloudflare-api-token)).

The dashboard's `*.workers.dev` address is turned off, so it's reachable only
at your own subdomain.

## Machines and their upload keys

- **Each machine has its own upload key**: 256 random bits, given to the
  machine once when it's approved. The dashboard stores only a SHA-256 hash of
  it.
- **An upload key can only upload that machine's usage.** It can't read the
  dashboard or touch other machines' data.
- **Revoking a machine** on the dashboard stops its key immediately, without
  affecting other machines.
- **On the machine**, the key is in `config.json` in your user profile's
  settings folder; on Linux the file is readable only by you.
- **Uploads are checked** against the upload format and limits (at most
  256 KiB, 100 days and 50 models per day per upload) before anything is
  stored, and each machine can upload at most once a second.

## Approving new machines

- A joining machine gets an **8-character code** (about 40 bits), valid for
  **10 minutes**. Only an admin, or a manager approving into their own
  department, can approve it.
- The Approvals page shows admins each waiting machine's name, system and
  request time, so you can check you're approving the machine in front of
  you. Managers don't see the list; they approve the code they were given.
- The code alone isn't enough to get the key: the machine collects its key with
  a separate secret it never shows, which the dashboard stores only as a hash.
- At most 20 requests can wait at once, and each network can start 5 every 10
  minutes.

## Enrollment keys

- **An enrollment key only lets machines ask to join.** Nothing they send
  is stored, and they get no upload key, until an admin (or a manager of the
  key's department) approves each of them on the Approvals page. Requests
  expire after 30 days.
- A key is **256 random bits**, shown once when it's created. The dashboard
  stores only a SHA-256 hash of it. It can **expire** and be limited to a
  number of machines, and **revoking** it stops it at once and denies the
  machines still waiting with it.
- **Wrong keys are slowed down:** after 10 from one network in 10 minutes,
  that network has to wait. At most 5,000 machines can wait at once.
- Managers create keys only for the departments they manage, and approve only
  those departments' machines.
- **Keys stay off the command line.** The install commands pass the key in
  the environment (through `sudo --preserve-env`), which other accounts can't
  read; the command line of a running program is visible to every account.
  `ccunified setup` also reads it from a file (`--enroll-key-file`) or
  standard input (`--enroll-key -`), and warns when it's given on the command
  line.
- **On a computer set up for every account**, the key and each account's
  upload key are in a folder only administrators can read (`/var/lib/ccunified`
  or `%ProgramData%\ccunified`). The folder is created that way from the
  start; one that already exists must be a real folder (not a link), and is
  taken over if someone else created it first (any account may create folders
  in ProgramData): Administrators become its owner, everything in it is made
  private, and links in it are removed. On Linux it must belong to root.
- ccusage runs **as each account**, with that account's rights and none of
  root's or SYSTEM's, so it reads only that account's files. On Windows,
  SYSTEM logs the account on without its password (an S4U logon, as Task
  Scheduler uses for tasks that store no password); if that fails, the
  account isn't synced rather than read as SYSTEM. It gets the computer's
  proxy settings without their user name and password. Each account's usage
  goes to its own machine on the dashboard.
- **The program root or SYSTEM runs is theirs alone.** Setup for every
  account copies it to `/opt/ccunified` (root's, writable by no one else) or
  `%ProgramFiles%\ccunified`, and refuses to copy it from a folder other
  accounts can change, such as someone's own install in their home folder
  (on Windows, another account's profile).

## Passwords

- **Passwords never leave your browser.** The browser stretches the password
  with 600,000 rounds of PBKDF2-SHA256 (OWASP's recommendation), salted per
  user and per dashboard, and sends only the result.
- **The dashboard stores a salted hash of that result** (another 5,000 rounds
  of PBKDF2-SHA256, with a random salt). A stolen copy of the database is
  therefore as slow to crack as if the server had done all 600,000 rounds.
- **Why in the browser:** Cloudflare's free plan allows about 10 ms of CPU time
  per request, and strong hashing doesn't fit: 100,000 rounds measured about
  17 ms. The setup wizard and `ccunified server reset-password` do the same
  calculation locally.
- Because the dashboard never sees passwords, the dashboard page and the wizard
  enforce the minimum length of 10 characters.

## Logins

- **Sessions** use a random token in a cookie that scripts can't read, that's
  only sent over HTTPS and that isn't sent with requests from other sites. The
  dashboard stores only a hash of it.
- A session lasts at most **14 days**. Logging out ends it. Changing your
  password ends your other sessions, and an admin or your manager disabling
  you or resetting your password, or an admin changing your dashboard-wide
  role, ends all of them, immediately. A change to your department roles
  applies from your next request.
- **Failed logins are limited** to 10 per username and 50 per network in 15
  minutes. Unknown usernames take as long to check as real ones, so they can't
  be told apart.
- **Two-factor login** (optional per user) uses standard 6-digit authenticator
  codes (RFC 6238). A code can't be used twice. The 10 recovery codes work once
  each and are stored only as hashes.
- **Roles** (dashboard-wide admin and viewer, and manager, viewer and member
  of a department) are checked by the server on every request, and the server
  only sends each person the usage, machines and people they may see; see
  [Who can do what](dashboard.md#who-can-do-what).
- Requests that change anything must come from the dashboard's own pages.

## Browser protections

The dashboard sends strict security headers: a content security policy that
allows only its own scripts and styles, a ban on being embedded in other
sites, `no-referrer`, HTTPS-only (HSTS), and no caching of API answers.

## The software itself

- **Releases are built by GitHub Actions** from this public repository, and
  every release includes SHA-256 checksums. The installers and
  `ccunified update` check them before installing.
- **ccusage is pinned** to an exact version. Its download is checked against
  npm's published integrity hash at build time, and the program is checked
  against a pinned SHA-256 before **every** run.
- **GitHub Actions** used by the build are pinned to exact commits.
- **Not yet signed:** releases have checksums but no code signatures, so they
  protect against damaged downloads, not against someone who takes over the
  GitHub account. Windows may show a SmartScreen warning for unsigned programs;
  the one-line installers normally avoid it.
