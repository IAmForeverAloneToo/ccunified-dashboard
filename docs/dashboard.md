# Using the dashboard

Open your dashboard's address (for example `https://usage.example.com`) in any
browser, on a computer or a phone. It follows your system's light or dark mode;
the **Theme** button at the top switches between system, light and dark.

## Logging in

Log in with your username and password. If two-factor login is on for your
account, you're also asked for the 6-digit code from your authenticator app,
or one of your recovery codes.

A login lasts 14 days on that browser, or until you click **Log out**. After
too many wrong passwords, logging in is blocked for a while (see
[Security](security.md#logins)).

## Who can do what

People can have a role for the whole dashboard, roles in
[departments](#departments-admins), or both.

**Dashboard-wide roles:**

- **Admin:** sees and manages everything: machines, users, departments and
  settings.
- **Viewer:** sees every machine's usage and the settings, and changes nothing.

**Roles in a department** (a department groups machines and people, such as
Engineering or Design):

- **Manager:** sees the department's machines; approves machines into it;
  renames, moves (between departments they manage), revokes and removes them; picks
  their owners; creates enrollment keys for adding many of them; and adds and manages its people (see [Users](#users)).
- **Viewer:** sees the department's machines.
- **Member:** can own machines in the department, and sees only the ones they
  own.

Everyone sees the machines they own, and a machine has at most one owner
(none makes it shared). Someone with only department roles doesn't see the
Settings page.

Department roles mostly matter for people without a dashboard-wide role. An
admin needs none. A viewer of everything already sees every machine, so for
them a department role only does something as **Manager** (to manage that
department) or **Member** (to own its machines); the Users page offers just
those.

| | Member | Department viewer | Manager | Viewer | Admin |
|---|---|---|---|---|---|
| See their own machines | ✓ | ✓ | ✓ | ✓ | ✓ |
| See a department's machines | | ✓ | ✓ | ✓ (all) | ✓ (all) |
| Approve, rename, move, revoke and remove machines; pick owners; create enrollment keys | | | ✓ (their departments) | | ✓ |
| Add and manage users | | | ✓ (see [Users](#users)) | | ✓ |
| Manage departments and settings | | | | | ✓ |
| Change their own password and two-factor login | ✓ | ✓ | ✓ | ✓ | ✓ |

The server checks these rights on every request, and only sends each person
the usage of the machines they may see; they're not just hidden buttons.

## Overview

The overview answers "how much did I use my coding tools, and where":

- **Period:** today, 7, 30 or 90 days, a year, or all time (*All* starts at the
  first day with any usage), or any dates you pick with **Custom** (see below).
- **Split by:** machine, model, or tool (*Tool* appears once a second tool
  has reported usage).
- **Show:** all tokens (input, output and cache), output tokens only, or
  estimated cost.
- **Machines, Tools, Models:** limit the whole page to some of them (see
  [Filtering](#filtering-to-some-machines-tools-or-models)).
- **Totals** for the period: tokens (with how many were cache reads), output
  tokens, estimated cost, and how many machines are reporting on schedule.
- **Chart:** one column per day (per week over 92 days, per month over two
  years), stacked by machine or model. Hover over or tab to a column to see
  its numbers; **Show as table** shows the same data as a table.
- **Machines, Tools and Models tables** with each one's input, output, cache
  and total tokens, estimated cost and share of the period. The Tools table
  appears once a second tool has reported usage.
- **Notices** when machines are waiting for approval or haven't reported on
  schedule.

Days begin and end in the dashboard's time zone (shown under the page title).
The page refreshes while the period includes today: every minute for
periods up to 92 days, and every 10 minutes for longer ones.

### Picking your own dates

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/date-range-dark.png">
  <img alt="The date picker open under the Period controls: From and To fields, shortcuts such as Last month, and two months of calendar with September 10 to 25 highlighted" src="images/date-range-light.png">
</picture>

Click **Custom** next to the period buttons:

1. Click the first day, then the last; the range is highlighted as you move
   the pointer. Clicking a day twice picks just that day. You can also type
   the dates (like `2026-09-03`) in **From** and **To**, or use a shortcut:
   this or last week, month or year.
2. Click **Apply** (or press Enter in a date field). **Cancel**, Escape or
   clicking elsewhere leaves the period as it was.

- **Dots** mark the days that have any usage.
- **Days after today** (in the dashboard's time zone) can't be picked.
- A range can be up to about ten years long.
- The address includes the dates, so a custom period survives a reload, can
  be bookmarked or shared, and **Back** returns to the previous period.
- On a phone, the calendar opens as a full-width panel showing one month.
- **With the keyboard:** the arrow keys move by day and week, Page Up and Page
  Down by month (with Shift, by year), Home and End to the start and end of
  the week, and Enter picks a day.

### Filtering to some machines, tools or models

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/filters-dark.png">
  <img alt="Machines set to Laptop, and the Models filter open under it: only the model families Laptop used (Haiku, Mythos, Opus, Sonnet and Gemini), with Gemini expanded and only gemini-3-pro ticked" src="images/filters-light.png">
</picture>

**Departments**, **Machines**, **Tools** and **Models**, under the period,
limit everything on the page to what you tick: the totals, the chart, the
tables and the date picker's dots. **Departments** appears once the machines
you see belong to more than one department (machines without one count as
*No department*); the chart can also be split by department.

- Tick one or more; **All**, the default, turns that filter off. Filters
  combine: Tools *Kimi* with Machines *Home PC* shows Kimi's usage on Home PC.
- **Models** lists model families (Opus, GPT, Kimi, …). Ticking a family
  includes all of its models, also ones that show up later; click ▸ to pick
  exact models instead (the family then shows as partly ticked).
- Each list offers only what was used, in the period shown, together with
  what you ticked in the others: with Machines *Laptop*, Tools and Models
  list just Laptop's tools and models. A list isn't narrowed by its own ticks,
  so you can still add more.
- A tick that no longer matches anything (after a change of period, or of the
  other filters) stays ticked, dimmed, with a note such as *no usage in this
  period*, so it's clear why the page is empty. Untick it to drop it.
- **Clear filters** turns them all off.
- The address includes the filters, so they survive a reload and can be
  bookmarked or shared; **Back** undoes the changes made while a list was
  open.
- Each list appears once the period has more than one thing to pick from,
  and stays however far the other filters narrow it.
- With the keyboard: Tab to a list's button and press Enter, Tab between the
  checkboxes and press Space to tick, and Escape to close.

### Tools and models

Each machine uploads the usage of every coding tool ccusage finds on it, such
as Claude Code, Codex, Gemini CLI, GitHub Copilot CLI and OpenCode.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/tools-dark.png">
  <img alt="The overview's chart split by tool: daily tokens stacked by Claude Code, Codex, Gemini CLI, OpenCode and Kimi" src="images/tools-light.png">
</picture>

- **Colors:** each tool keeps its color: tools get colors in the order the
  dashboard first saw them. Past eight tools, the newest share a gray *Other
  tools* in the chart (the Tools table still lists each one).
- **Models** are grouped into families in the chart, whichever tool used
  them, and the Models table lists every exact model name. Claude models are
  grouped by the name after "claude" (Opus, Sonnet, Haiku, Mythos, and any
  new family), other vendors' models by their family (GPT, Gemini, Grok,
  Kimi, Qwen, GLM, DeepSeek, …), and anything else by the first word of its
  name. Like tools, families get colors in the order the dashboard first saw
  them; a family seen after the eighth takes a color that no other family in
  view uses. Only when a chart shows more than eight families at once do the
  newest share a gray *Other models*. A model used through several tools (say, Claude Sonnet in Claude
  Code and in OpenCode) is one model.

Costs are **estimates at API prices**. By default they're calculated by
ccusage on each machine (OpenCode's are the costs OpenCode itself recorded);
admins can have the dashboard use the public price lists or their own prices
instead (see [Prices](#prices)), and the Models table then says where each
model's price came from. A subscription isn't billed per token, so treat
costs as a measure of usage.

## Machines

The machines you can see, with their department and owner (once there are
departments or owners), status, last upload and upload interval, operating
system, the tools they've reported (once there's more than one), ccunified
version and 30-day token total. **Search** by name, owner, department or
system, pick a **Department**, and click a column's name to sort by it; long
lists come in pages of 50.

Admins, and managers for their departments' machines, can **Edit** a machine
(its name, department and owner) and **Revoke** it; a revoked machine can then
be **Removed**, keeping its usage in the totals (as *Removed machines* on the
Overview) or deleting it. The owner is someone with
a role in the machine's department, or an admin; admins can give a machine
without a department any owner. The *Add a machine* card shows the install
commands and your dashboard's address. Machine statuses and removing machines
are explained in [Add machines](adding-machines.md#machine-status).

Admins and managers also see **Add many machines**: the enrollment keys they
manage, with how many machines each added, how many wait for approval, when it
stops working and when it was last used, and a button to **Revoke** it; the
list refreshes every minute. **Create an enrollment key** to add machines from
a script; see [Add many machines](adding-machines.md#add-many-machines-with-a-script).
The new key is shown only once, so its window stays open (Escape doesn't close
it) until you click **Done**. Recovery codes for two-factor work the same way.

## Approvals (admins and managers)

Type the code a new machine shows, pick its **Department** and **Owner**, and
**Approve** or **Deny** it; see [Add machines](adding-machines.md#join-a-machine).
Managers approve machines into a department they manage; admins may leave the
department out. Only admins see the list of machines waiting with a code.

Machines that joined with an enrollment key are listed under **Joined with an
enrollment key**, with the department and owner they get from the key. Tick
some (or tick the header to pick them all) and **Approve** or **Deny** them
together; hundreds go in batches of 200, and if a batch fails, the message says
how many were done and the rest stay ticked to try again. Managers see those of
the departments they manage. The badge on
**Approvals** counts every machine waiting that you can approve.

## Departments (admins)

Add, rename and delete departments, and see how many machines and people each
has. Deleting a department leaves its machines without a department (keeping
their owners) and removes its people's roles in it. Give people roles on the
[Users](#users) page, and put machines in a department when approving them or
with **Edit** on the [Machines](#machines) page.

## Users

Admins manage everyone. Managers see the people with a role in the
departments they manage, and manage the *plain* ones: people with no
dashboard-wide role, a manager nowhere, and only in departments this manager
manages. They can't make anyone an admin, a viewer of everything or a manager.

- **Add a user:** choose a username (3–32 letters, digits, dots, dashes or
  underscores; it can't be changed later), their access, and a temporary
  password. Give them the password privately; they must choose their own when
  they first log in. Once there are departments, new people start without a
  dashboard-wide role, so you pick their department roles; the form only
  offers the department roles that mean something with the dashboard-wide
  role you pick. Managers add people to their departments, as viewers or
  members.
- **Access…** changes someone's dashboard-wide role (admins) and their roles
  in departments. Changing the dashboard-wide role signs them out, so it
  applies at once. Someone who leaves a department stops owning its machines.
- **Reset password** sets a new temporary password and signs them out
  everywhere.
- **Reset two-factor** turns their two-factor login off, for when they've lost
  their authenticator and their recovery codes.
- **Disable** blocks their login and signs them out, without deleting them;
  **Enable** undoes it. **Delete** removes them for good; machines they owned
  become shared.

You manage your own account on the *Your account* page instead. There's
always at least one active admin: the last one can't be disabled, deleted or
lose the role.

## Your account

Click your username at the top right.

- **Password:** change it (at least 10 characters). Your other sessions are
  signed out.
- **Two-factor authentication:**
  - **Set up two-factor:** scan the QR code with an authenticator app (Google
    Authenticator, 1Password, Microsoft Authenticator, …), enter the code it
    shows, and save the 10 **recovery codes** it gives you (copy or download
    them). Each recovery code logs you in once if you lose your phone.
  - **New recovery codes** replaces the old ones.
  - **Turn off** removes two-factor from your account.

If an admin is locked out completely (forgotten password, no recovery codes),
run `ccunified server reset-password` on any of your machines; see the
[command reference](commands.md#ccunified-server-reset-password).

## Settings

Admins and viewers of everything see this page.

- **Days (admins):** the dashboard's time zone. Changing it regroups usage into
  the new zone's days: each machine notices on its next upload and uploads its
  history again, grouped the new way. Days older than the logs still on a
  machine keep their old grouping.
- **Prices:** how the estimated costs are worked out; see [Prices](#prices).
- **Version:** the ccunified version the dashboard runs, whether a newer
  release exists, and when the dashboard last asked GitHub. It asks on its
  own every 6 hours; **Check for updates** asks right away. If GitHub can't
  be reached, the page says *Couldn't check for updates* and why, rather than
  that the dashboard is up to date. See [Updating](commands.md#updating).

### Prices

Admins choose how the dashboard's estimated costs are worked out; viewers of
everything can see the choice and the prices.

- **ccusage (default):** the cost each machine's ccusage worked out, request
  by request, from the prices it downloads (models.dev, else LiteLLM, else the
  prices built into it).
- **Price lists:** each model's maker's price (Anthropic's for Claude, OpenAI's
  for GPT, Moonshot's for Kimi, …) on [models.dev](https://models.dev), or
  else on [LiteLLM](https://github.com/BerriAI/litellm)'s list. Sellers that
  resell a model at other prices, and free subscription plans, are ignored.
  Models in neither list keep ccusage's cost. The table shows which entry each
  model matched. The machines download the lists at most once a day and send
  the dashboard its models' prices; machines need ccunified 0.5 or later.
- **Custom:** your own prices (US dollars per million tokens of input,
  output, cache writes and cache reads) for the models you fill in; the
  others are priced as with the price lists. Leave a model's four prices
  empty to drop its custom price.

A change applies to all history, and every total, chart and table follows
it. The dashboard keeps daily totals rather than single requests, so with the
price lists or custom prices, long-context surcharges (such as Claude's higher
rate past 200,000 input tokens) and the 1-hour cache-write rate aren't
applied; ccusage applies them.

