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

## Uploads

**"No Claude Code logs on this machine yet"**: nothing to upload until Claude
Code has been used on this machine. If Claude Code keeps its data in a
non-standard place, set `CLAUDE_CONFIG_DIR` (see the
[command reference](commands.md#environment-variables)).

**"couldn't reach the dashboard"**: a network problem. The background sync
tries again on its next run; to try now, run `ccunified sync`.

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

## Numbers look different from elsewhere

- **Costs are estimates** at Anthropic's API prices, calculated by ccusage. A
  Claude subscription isn't billed per token.
- **Days follow the dashboard's time zone**, so a day's numbers can differ
  from a tool that uses your local time zone or UTC.
- **History before a machine joined** is limited to the logs still on it.
  Claude Code deletes old session logs (after 30 days by default), so older
  usage can't be uploaded. From the day a machine joins, the dashboard keeps
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
