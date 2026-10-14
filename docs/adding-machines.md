# Add machines

Every machine after the first joins your existing dashboard. Joining doesn't
need a Cloudflare token: the machine asks to join, and an admin approves it on
the dashboard.

## Join a machine

1. **Install ccunified** on the machine with the same command as before. The
   dashboard's **Machines** page shows the commands and your dashboard's
   address under *Add a machine*.

   Windows (PowerShell):

   ```powershell
   irm https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.ps1 | iex
   ```

   Linux:

   ```sh
   curl -fsSL https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.sh | sh
   ```

   If ccunified is already installed, run `ccunified setup` instead.

2. **Choose 2) Join an existing dashboard** and answer three questions:
   - **Dashboard address**, for example `usage.example.com` (`https://` is
     optional). The wizard checks that a ccunified dashboard answers there.
   - **Name for this machine**, shown on the dashboard. The default is the
     computer's name.
   - **How often to upload:** every 15, 30 or 60 minutes.

3. **The machine shows a code** and waits:

   ```
     ┌────────────────────────────┐
     │   Your code:  K7QX-82MD    │
     └────────────────────────────┘
   ```

4. **Approve it on the dashboard.** As an admin, from any device, open
   **Approvals** (a badge on it shows how many machines are waiting). Type the
   code; upper or lower case and the dash don't matter. Check that the waiting
   machine's name and system are the ones you expect, optionally give it a
   different name, then click **Approve**.

5. **The machine finishes on its own** within a few seconds: it saves its
   settings, sets up the background sync and uploads its usage history.

The code works for 10 minutes. If it expires, the machine offers a new one.
Only approve codes you can see on your own machine's screen.

## Linux: keep syncing while logged out

On Linux the background sync is a systemd *user* timer, and systemd stops a
user's timers when they log out, unless *lingering* is on for that user. The
wizard offers to turn it on (it runs `loginctl enable-linger`, which may ask for
your sudo password once). Say yes on servers and other machines you don't stay
logged in to.

Without systemd, the wizard uses a cron entry instead, which keeps running
while you're logged out anyway.

On Windows, the sync is a Task Scheduler task that runs while you're signed in
to Windows, and catches up after the computer wakes or you sign in again.

## Change a machine's upload interval

On the machine:

```sh
ccunified config set interval 15    # or 30, or 60
```

The background sync is updated right away.

## Machine status

The **Machines** page shows each machine's status:

| Status | Meaning |
|---|---|
| Reporting | Uploaded recently |
| Late | Missed two of its scheduled uploads (plus 10 minutes' slack). The overview shows a warning too |
| Waiting for first upload | Approved, but hasn't uploaded yet |
| Revoked | Its upload key no longer works (see below) |

A machine running an older ccunified than the latest release shows **Update
available**; run `ccunified update` on it.

## Rename a machine

Admins can click **Rename** on the Machines page. Names must be unique among
active machines. The new name is used for all of the machine's usage,
including its history.

## Remove a machine

There are two separate steps, and you usually want both:

- **On the machine**, run `ccunified uninstall`. It removes the background
  sync, the machine's settings (including its upload key) and the program.
- **On the dashboard**, an admin clicks **Revoke** on the Machines page. The
  machine's upload key stops working immediately. Its past usage stays on the
  dashboard and in the totals.

If a machine is lost or stolen, revoke it; that's all it takes to stop it from
uploading.

## Set up a machine again

Running `ccunified setup` again on a connected machine asks before replacing
its settings, and the machine gets a new upload key. If it joins again, it
becomes a new machine on the dashboard; revoke the old entry, or approve the
new one under a different name (names must be unique among active machines).
