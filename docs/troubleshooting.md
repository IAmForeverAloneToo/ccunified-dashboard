# Troubleshooting

Start with `ccunified status` on the machine in question. It shows the last
successful upload, the last problem since then, and whether the background
sync is set up. More detail is in the log file, `ccunified.log`, in the
settings folder (`%APPDATA%\ccunified` on Windows, `~/.config/ccunified` on
Linux).

## Installing

**Windows: `ccunified` isn't recognized.** The installer adds ccunified to your
PATH and to the window it ran in. Other windows that were already open don't
see the change; open a new one.

**Linux: `ccunified: command not found`.** The command is linked in
`~/.local/bin`, which some systems only add to your PATH after you log out and
back in. Until then, run `~/.local/bin/ccunified`.

## Creating the dashboard

**"Cloudflare didn't accept that token: Invalid access token (code 9109)"**

- The token's TTL **starts in the future**. Cloudflare's TTL is a date range;
  a token whose range starts tomorrow doesn't work today. Create a new token
  with the TTL cleared, or starting today.
- **The wrong text was copied.** Copy the token from the box Cloudflare shows
  right after *Create Token*, not the sample `curl` command below it. The
  token is only shown once; if it's gone, create a new one.
- The token was deleted, or its TTL has ended.

You can paste a new token at the same prompt; there's no need to restart
setup. To check a token on its own, run (in PowerShell, use `curl.exe`):

```sh
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer YOUR-TOKEN"
```

A good token answers with `"status":"active"`.

**"the token can't see any active domain"**

- The domain isn't **Active** on Cloudflare yet; see
  [Before you start](setup.md#before-you-start). A domain you just added
  becomes Active once Cloudflare sees the nameserver change.
- The token's *Zone Resources* don't include the domain, or the token is
  missing *Zone › Zone › Read*.

**"… is already in use (it has a DNS record)"**: the subdomain already points
somewhere. Choose another name; the wizard never overwrites existing records.

**"this Cloudflare account already has a ccunified dashboard"**: there's
already a `ccunified` database on the account. To connect this machine to that
dashboard, run `ccunified setup` and choose *Join*. To upgrade it, use
`ccunified server update`. To start over, delete it with
`ccunified server remove` first.

**"this Cloudflare account already has a Worker called "ccunified""**: another
Worker uses that name. Rename or delete it in Cloudflare, or use another
account.

**A step failed partway.** The wizard offers to remove what it created. Accept,
fix the problem it reported, and run `ccunified setup` again.

## The dashboard doesn't open right after setup

If your browser says *Server not found* (or `ccunified` reports *no such host*)
while the dashboard is up:

The first time a computer looks up a new address, its network may remember
the answer "doesn't exist" for **up to 30 minutes**. If anything on your network
looked up the subdomain before Cloudflare published it, that answer sticks
around, even though the dashboard is online.

- **Check from somewhere else**, for example a phone on mobile data, or in
  Cloudflare under **Workers & Pages › ccunified**.
- **Wait.** It clears by itself within 30 minutes.
- **Clear your computer's copy:** `ipconfig /flushdns` on Windows. This doesn't
  clear your router's copy.
- **Use a public DNS service** such as Cloudflare's `1.1.1.1` or Google's
  `8.8.8.8`, in your network adapter's DNS settings or your browser's *secure
  DNS* setting.

The setup wizard (version 0.1.1 and later) waits until Cloudflare's public DNS
has the new address before looking it up, so it doesn't cause this itself.
Uploads aren't affected either: when a computer's DNS says the dashboard
doesn't exist, ccunified uses the address from Cloudflare's public DNS
(over HTTPS, so it's still your dashboard it talks to).

## Adding machines

**"no ccunified dashboard answered at …"**: check the address (it's the one you
log in at) and that the dashboard opens in a browser.

**The code expired** (after 10 minutes): the machine offers a new one.

**"the dashboard has too many machines waiting to join right now"**: at most 20
requests can wait at once, and each network can start 5 every 10 minutes. Deny
stale requests on the Approvals page, or wait a few minutes.

**Approving says "Another machine is already called …"**: names must be unique
among active machines. Enter a different name on the Approvals page, or revoke
the old machine first.

**With an enrollment key:**

- **"the dashboard doesn't know this enrollment key"**: it was mistyped or cut
  short; copy it again from where you saved it (the dashboard shows it only
  once; create a new one if it's lost).
- **"this enrollment key was revoked"**, **"has expired"** or **"has been used
  for as many machines as it allows"**: create a new key on the Machines page.
- **"this dashboard doesn't accept enrollment keys yet"**: update the dashboard
  with `ccunified server update`.
- **"too many wrong enrollment keys were tried from this network"**: wait 10
  minutes.
- **A machine doesn't appear on the Approvals page**: run `ccunified status`
  on it (as root or an administrator, `ccunified status --all-users`). On a
  computer set up for every account, an account asks to join only once it has
  usage.
- **Approved, but nothing uploaded yet**: the machine finds out at its next
  sync, within its upload interval. Run `ccunified sync` on it (or
  `ccunified sync --all-users`) to start right away. If `ccunified status`
  shows a *Last problem*, that's why the last try failed.
- **"this machine is already waiting for approval on …"**: it asked another
  dashboard to join. To switch, run `ccunified uninstall`, then set it up
  again.

## Uploads

**"No usage found on this machine yet"**: nothing to upload until Claude Code
(or another tool ccusage reads) has been used on this machine. If a tool keeps
its data in a non-standard place, set the variable it uses, such as
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` (see the
[command reference](commands.md#environment-variables)).

**"The dashboard accepts Claude Code usage only"**: the dashboard on
Cloudflare is from ccunified 0.1. Run `ccunified server update` on a machine
with the new version; each machine then uploads every tool's history on its
next sync.

**A tool's usage is missing.** `ccunified status` lists the tools the machine
has reported. If a *Note* says only Claude Code's usage could be read, ccusage
failed to read the others; the message says why, and the next sync tries
again. Tools ccusage doesn't support can't be shown.

**"couldn't reach the dashboard"**: a network problem. The background sync
tries again on its next run; to try now, run `ccunified sync`.

**"the dashboard is busy and asked to wait …"**: the dashboard asked for a
pause of more than a minute. The next scheduled sync tries again, and sends
everything since the last successful one.

**"another sync is already running on this machine"**: a sync (or
`ccunified setup --enroll-key`) was still running. If no sync is running, the
lock is left from one that was stopped; it's taken over once its program has
ended (on Windows, after 30 minutes).

**"ccusage took too long reading the logs and was stopped"**: reading the
logs took more than 5 minutes, usually on a slow disk with a very large
history. The next sync tries again.

**A *Note* says some days "had more than 50 models"**: the dashboard takes at
most 50 models per day; the smallest were added up as `other-models`, so no
tokens or costs are lost.

**"this machine was revoked on the dashboard"** or **"the dashboard didn't
accept this machine's upload key"**: the machine needs to join again; run
`ccunified setup`.

**"ccusage does not match the pinned version"** or **"ccusage was not found
next to ccunified"**: the bundled ccusage is missing or changed (an antivirus
quarantine, for example). Reinstall with `ccunified update --force`.

## A machine shows as Late

The machine missed two scheduled uploads. Usually it's simply off or asleep,
and catches up on its own once it's back. Otherwise:

- Run `ccunified status` there. If the *Schedule* line doesn't show the
  background sync, repair it with `ccunified setup --schedule-only`.
- **Windows** only syncs while you're signed in.
- **Linux** stops syncing when you log out unless lingering is on; see
  [Add machines](adding-machines.md#linux-keep-syncing-while-logged-out).

## Updating

**Settings still shows the old version after `ccunified update`.** Settings
shows the version of the dashboard on Cloudflare, which only
`ccunified server update` changes; `ccunified update` updates the program on a
machine. Run `ccunified server update` on a machine you've already updated.

**"the dashboard runs ccunified …, which is newer than this program"**: you
ran `ccunified server update` on a machine with an older ccunified. Run
`ccunified update` there first.

**A new release isn't shown as available yet.** The dashboard checks GitHub
for new releases every 6 hours, and also learns about one as soon as any of
your machines uploads with it. To check right away, click **Check for
updates** on the Settings page.

**"Couldn't check for updates"** on the Settings page: the dashboard couldn't
get an answer from GitHub, for the reason shown. GitHub's API limits how
many requests each internet address may make, and Cloudflare's addresses are
shared by many sites; when the API refuses, the dashboard asks GitHub's
releases page instead, so this is usually brief. Try again later; the
dashboard also tries again on its own every 6 hours.

## Numbers look different from elsewhere

- **Costs are estimates** at API prices, calculated by ccusage (for OpenCode,
  the cost OpenCode recorded). A subscription isn't billed per token.
- **Days follow the dashboard's time zone**, so a day's numbers can differ
  from a tool that uses your local time zone or UTC.
- **History before a machine joined** is limited to the logs still on it.
  Claude Code deletes old session logs (after 30 days by default), and other
  tools may too, so older usage can't be uploaded. From the day a machine joins, the dashboard keeps
  its history for good.

## Logging in

**Too many failed logins**: logging in for that username (or from your
network) is blocked for up to 15 minutes. Wait and try again.

**Forgotten password**: another admin can set a temporary one on the **Users**
page. If no admin can log in, run `ccunified server reset-password` on any of
your machines.

**Lost authenticator**: log in with one of your recovery codes. Without them,
another admin can turn off your two-factor login on the **Users** page, or
`ccunified server reset-password` can do it.
