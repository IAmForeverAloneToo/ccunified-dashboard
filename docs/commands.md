# Command reference

```
ccunified <command> [options]
```

`ccunified help` lists the commands and `ccunified help <command>` shows a
command's options. Commands exit with 0 on success, 1 on failure and 2 when
the command line is wrong.

## On every machine

### `ccunified setup`

The setup wizard: **create a new dashboard** (first machine; see
[Create your dashboard](setup.md)) or **join an existing one** (see
[Add machines](adding-machines.md)). On a machine that's already connected, it
asks before replacing its settings.

| Option | |
|---|---|
| `--no-schedule` | Don't set up the background sync, for when you run `ccunified sync` from your own scheduler |
| `--schedule-only` | Only set up (or repair) the background sync, using the existing settings |

### `ccunified sync`

Uploads this machine's usage now. The background sync runs this command, so
you rarely need it, but it's always safe to run: sending a day twice never
counts it twice.

It uploads the usage of every coding tool ccusage finds on the machine:
Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, OpenCode and the others
ccusage supports. A dashboard that hasn't been updated to ccunified 0.2 yet
accepts Claude Code's usage only; `sync` then says to run `ccunified server
update`, and the first sync after that uploads every tool's history.

A normal sync re-sends the last 7 days. The first sync on a machine, the
first after the dashboard's time zone changes, and the first after the
dashboard starts accepting every tool send the whole history still on disk.

| Option | |
|---|---|
| `--full` | Send the whole history, not just the last 7 days |
| `--quiet` | Print nothing (used by the background sync) |

### `ccunified status`

Shows the dashboard address, this machine's name, the time zone, the upload
interval, the state of the background sync, the last upload and any problem
since, the tools this machine has reported usage for, whether an update is
available, and whether the bundled ccusage passed its integrity check.

### `ccunified config`

| | |
|---|---|
| `ccunified config show` | Dashboard, machine name, time zone and interval |
| `ccunified config set interval 15` | Upload every 15, 30 or 60 minutes. The background sync is updated right away |

### `ccunified update`

Installs the latest release of ccunified on this machine: downloads it, checks
it against the release's SHA-256 checksums, replaces the program files and
refreshes the background sync.

| Option | |
|---|---|
| `--check` | Only say whether an update is available |
| `--force` | Reinstall even if this version is the latest |

### `ccunified uninstall`

Removes ccunified from this machine: the background sync, the settings
(including the upload key), the log, and the program, including its PATH entry
on Windows. The dashboard and the usage it already has aren't affected; revoke
the machine on the dashboard to stop its key from ever working again.

| Option | |
|---|---|
| `--yes` | Don't ask for confirmation |

### `ccunified version`

Prints the versions of ccunified and of the bundled ccusage.

## For the dashboard on Cloudflare

These change the dashboard itself, so each asks for a Cloudflare API token
with the same permissions as during setup. Each shows a link that opens
Cloudflare's token page with those permissions filled in, and lists them (see
also [Create your dashboard](setup.md#2-create-the-cloudflare-api-token)). The
token is used only while the command runs; a token from earlier that hasn't
expired works too.

### `ccunified server update`

Brings the dashboard on Cloudflare up to this program's version: applies any
new database changes and uploads the new dashboard. Your data, users and
settings stay. Run it after `ccunified update`, on the machine you just
updated. It refuses to replace a newer dashboard with an older program's.

### `ccunified server reset-password`

```
ccunified server reset-password [username]
```

Sets a new password for a dashboard user, for when an admin is locked out. If
you leave out the username, it lists the users to choose from. It signs the
user out everywhere and can also turn off their two-factor login (it asks).

### `ccunified server remove`

Permanently deletes the dashboard from Cloudflare: its subdomain, the Worker
and the database with all usage, users and settings. You confirm by typing the
dashboard's hostname, such as `usage.example.com`. Afterwards, run
`ccunified uninstall` on each machine.

## Updating

- **The program on your machines:** run `ccunified update` on each one. The
  dashboard's **Machines** page marks the ones with an older version, and
  `ccunified status` says when a newer release exists.
- **The dashboard on Cloudflare:** the **Settings** page shows the version the
  dashboard itself runs, and says when a newer release exists. `ccunified
  update` doesn't change it; update one machine with `ccunified update`, then
  run `ccunified server update` there.

Not every release changes the dashboard; the release notes say which part
changed.

## Files on each machine

| What | Windows | Linux |
|---|---|---|
| Program | `%LOCALAPPDATA%\Programs\ccunified\` | `~/.local/share/ccunified/`, linked as `~/.local/bin/ccunified` |
| Settings (`config.json`, including the machine's upload key, readable only by you) | `%APPDATA%\ccunified\` | `~/.config/ccunified/` |
| Last upload (`state.json`) and log (`ccunified.log`, rotated at 1 MiB) | same folder as the settings | same folder as the settings |
| Background sync | Task Scheduler task `ccunified sync (<your user name>)`, running the windowless `ccunifiedw.exe` | systemd user timer `ccunified-sync.timer`, or a crontab line marked `# ccunified-sync` |

## Environment variables

| Variable | Effect |
|---|---|
| `CCUNIFIED_HOME` | Use this folder for the settings, state and log instead of the default |
| `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its data, if not in the default place (read by ccusage) |
| `CODEX_HOME` and the like | Where other tools keep their data, if not in the default place; ccusage reads the same variables the tools themselves use |
| `CCUNIFIED_NO_SETUP=1` | Installers only: install without starting `ccunified setup` |

Variables used for testing and development are listed in
[Development](development.md#environment-variables).
