# Add machines

Every machine after the first joins your existing dashboard. Joining doesn't
need a Cloudflare token: the machine asks to join, and an admin (or a
department's manager) approves it on
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
   - **How often to upload:** every 15 (the default), 30 or 60 minutes.

3. **The machine shows a code** and waits:

   ```
     ┌────────────────────────────┐
     │   Your code:  K7QX-82MD    │
     └────────────────────────────┘
   ```

4. **Approve it on the dashboard.** As an admin or a department's manager,
   from any device, open **Approvals** (for admins, a badge on it shows how
   many machines are waiting). Type the code; upper or lower case and the dash
   don't matter. Optionally give it a different name, pick its **Department**
   and **Owner** (managers approve into a department they manage), then click
   **Approve**. Admins can check the waiting machine's name and system in the
   list below the form.

5. **The machine finishes on its own** within a few seconds: it saves its
   settings, sets up the background sync and uploads its usage history.

The code works for 10 minutes. If it expires, the machine offers a new one.
Only approve codes you can see on your own machine's screen.

## Add many machines with a script

For a deployment tool, a login script or anything else that sets up many
machines, use an **enrollment key** instead of codes. Machines ask to join
without anyone typing anything, and you approve them on the dashboard, one at
a time or all at once.

1. **Create a key.** On the **Machines** page, under *Add many machines*,
   click **Create an enrollment key**. Give it a name and pick the
   **Department** and **Owner** the machines get, when the key **stops
   working** (30 days unless you choose otherwise), and how many **machines it
   can add**. Admins can pick any department, or none; managers pick one they
   manage. The key is shown once, with the commands that use it.

2. **Run the command on each machine**, or give it to your deployment tool.
   The commands install ccunified and set it up without asking anything:

   | | |
   |---|---|
   | Linux, one account | `curl -fsSL …/install.sh \| CCUNIFIED_URL=https://usage.example.com CCUNIFIED_ENROLL_KEY=ccu_e_… sh` |
   | Linux, every account | `curl -fsSL …/install.sh \| sudo env CCUNIFIED_URL=https://usage.example.com CCUNIFIED_ENROLL_KEY=ccu_e_… sh` |
   | Windows, one account | `$env:CCUNIFIED_URL='https://usage.example.com'; $env:CCUNIFIED_ENROLL_KEY='ccu_e_…'; irm …/install.ps1 \| iex` |
   | Windows, every account | The same, run as SYSTEM (as Intune or Group Policy run scripts), or in an elevated window with `$env:CCUNIFIED_ALL_USERS='1'` added |

   `CCUNIFIED_NAME` sets the machine's name (default: its hostname) and
   `CCUNIFIED_INTERVAL` how often it uploads (15, 30 or 60 minutes; default
   15). On a machine that already has ccunified, run
   `ccunified setup --url https://usage.example.com --enroll-key ccu_e_…`
   instead (see [the commands](commands.md#ccunified-setup)).

3. **Approve them.** On the **Approvals** page, under *Joined with an
   enrollment key*, tick the machines (the box in the header ticks them all)
   and click **Approve**. Each request waits up to 30 days. A name another
   machine already has gets a number, like `LAPTOP-2`.

4. **They start uploading on their own**, at their first sync after you
   approve them (within their upload interval), with their whole history.

Running the command again on a machine changes nothing. If its request was
denied, or expired, running it again asks again.

### Every account on a computer

Run as root on Linux, or as SYSTEM on Windows (or with `--all-users` in an
elevated window), setup installs ccunified for the whole computer:

- **Each account is its own machine** on the dashboard, named like
  `LAPTOP (alice)`. Each account that uses a coding tool asks to join; one
  without usage asks once it has some, and so do accounts added later.
  Accounts where someone set ccunified up themselves are left alone, so no
  usage is counted twice.
- **One background sync for the computer** runs as root or SYSTEM, whether or
  not anyone is logged in: a systemd timer (or `/etc/cron.d/ccunified`) on
  Linux, the Task Scheduler task `ccunified sync (all users)` on Windows.
- **People's accounts only:** on Linux, accounts with an id of 1000 or more in
  `/etc/passwd`, and folders in `/home` (for accounts from a directory
  service); on Windows, the user profiles Windows lists.
- **On Linux, ccusage runs as each account**, so it reads only that account's
  files and leaves nothing owned by root in its home.
- The program goes to `/opt/ccunified` (with the command in
  `/usr/local/bin`) or `%ProgramFiles%\ccunified`, and the settings, including
  the enrollment key, to a folder only administrators can read:
  `/var/lib/ccunified` or `%ProgramData%\ccunified`.

`ccunified status --all-users` shows where each account stands, and
`ccunified uninstall --all-users` removes it all.

**Keep keys like passwords.** Anyone with a key can ask to add machines (but
nothing uploads until you approve them). Revoke a key on the Machines page
when you're done with it: machines still waiting with it are denied, and
those you approved keep uploading.

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

Admins, and managers for their departments' machines, can click **Edit** on
the Machines page to rename a machine, move it to another department or change
its owner. Names must be unique among
active machines. The new name is used for all of the machine's usage,
including its history.

## Remove a machine

There are two separate steps, and you usually want both:

- **On the machine**, run `ccunified uninstall`. It removes the background
  sync, the machine's settings (including its upload key) and the program.
- **On the dashboard**, an admin (or the manager of its department) clicks
  **Revoke** on the Machines page. The
  machine's upload key stops working immediately. Its past usage stays on the
  dashboard and in the totals.

A revoked machine stays on the Machines page, dimmed, until someone removes
it: an admin (or the manager of its department) clicks **Remove** on its row
and picks what happens to its usage:

- **Keep it in the totals:** the machine leaves the Machines page and the
  Overview's machine filter, but its tokens and costs still count. The
  Overview shows them as **Removed machines** (one gray series and one row
  for all removed machines), still in the machine's department.
- **Delete it:** the machine and all of its usage are deleted, and past
  totals drop by what it used.

Removing can't be undone. Only revoked machines can be removed, so revoke
first.

If a machine is lost or stolen, revoke it; that's all it takes to stop it from
uploading.

## Set up a machine again

Running `ccunified setup` again on a connected machine asks before replacing
its settings, and the machine gets a new upload key. If it joins again, it
becomes a new machine on the dashboard; revoke the old entry, or approve the
new one under a different name (names must be unique among active machines).
