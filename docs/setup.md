# Create your dashboard

You do this once, on your first machine. The setup wizard creates everything
on your Cloudflare account and connects that machine to it. It takes about ten
minutes, most of it in Cloudflare's website.

## Before you start

You need a Cloudflare account (the free plan is enough) with a domain on it,
and the domain's status must be **Active**:

- **If you bought the domain at Cloudflare**, it's already Active.
- **If it's registered somewhere else** (GoDaddy, Namecheap, …), add it to
  Cloudflare once:
  1. In the Cloudflare dashboard, click **Add a domain**, enter it and choose
     the **Free** plan. Cloudflare copies your existing DNS records, so a
     website or email on that domain keeps working.
  2. At your registrar, replace the domain's nameservers with the two that
     Cloudflare shows you.
  3. Wait until Cloudflare marks the domain **Active**. That's often a few
     minutes, but can take up to a day; Cloudflare emails you when it's done.

You don't need a server, an IP address or any DNS changes of your own. The
dashboard runs on Cloudflare's network, and the wizard has Cloudflare create
the dashboard's subdomain (such as `usage.example.com`), its DNS record and its
HTTPS certificate.

## 1. Install ccunified

On Windows, in PowerShell (no administrator rights needed):

```powershell
irm https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.ps1 | iex
```

On Linux (no root needed; uses `curl` or `wget`):

```sh
curl -fsSL https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.sh | sh
```

The installer downloads the release for your system, checks it against the
release's SHA-256 checksums, installs it for your user account and starts
`ccunified setup`:

- **Windows:** into `%LOCALAPPDATA%\Programs\ccunified`, which is added to your
  PATH.
- **Linux:** into `~/.local/share/ccunified`, with the `ccunified` command
  linked in `~/.local/bin`. If that folder isn't on your PATH yet, the
  installer says so; logging out and back in usually fixes it.

When setup asks what you'd like to do, choose **1) Create a new dashboard**.

## 2. Create the Cloudflare API token

The wizard needs a Cloudflare API token to create the dashboard. It uses the
token only while setup runs and never saves it.

1. Open the link the wizard prints. It opens Cloudflare's **Create Token** page
   with the right permissions filled in:

   | Permission | Why |
   |---|---|
   | Account › Workers Scripts › Edit | Upload the dashboard (a Cloudflare Worker) |
   | Account › D1 › Edit | Create the dashboard's database and set it up |
   | Account › Account Settings › Read | Find your account |
   | Zone › Workers Routes › Edit | Connect the dashboard to your subdomain |
   | Zone › Zone › Read | List your domains |
   | Zone › DNS › Read | Check that the subdomain you pick isn't already in use |

2. Optionally, narrow it down. These make the token safer and don't affect
   setup:
   - **Zone Resources:** change *All zones* to *Specific zone* and pick your
     domain.
   - **Account Resources:** if you have several accounts, pick the one for the
     dashboard.
   - **TTL:** let the token expire tomorrow. Make sure the range **starts
     today**: a token whose start date is in the future is rejected until that
     day (Cloudflare reports "Invalid access token (code 9109)").
   - Leave **Client IP Address Filtering** empty.
3. Click **Continue to summary**, check the dates and permissions, then
   **Create Token**.
4. Copy the token from the box Cloudflare shows (it's shown only once; don't
   copy the sample `curl` command below it). Paste it into the wizard and press
   Enter. Nothing appears on screen while you paste; that's on purpose.

## 3. Answer the wizard's questions

| Question | Notes |
|---|---|
| Which domain | Only asked if the token can see more than one Active domain |
| Subdomain | Press Enter for `usage`, or type another name. It must not be in use yet: the wizard refuses names that already have a DNS record, so nothing of yours is overwritten |
| Time zone | The days on the dashboard start and end in this zone. The default is your computer's; type part of a city name to search. Admins can change it later |
| Admin username and password | Your dashboard login. At least 10 characters, typed twice. You can add more people later |
| Name for this machine | How it's labelled on the dashboard. The default is the computer's name |
| How often to upload | Every 15, 30 (default) or 60 minutes |

The wizard then shows a summary and asks **Create it now?** Nothing is created
on Cloudflare before you answer **Y**.

## 4. Watch it build

```
  ✓ Created the database
  ✓ Set up the database tables
  ✓ Set the time zone to Asia/Tokyo
  ✓ Created the admin account "admin"
  ✓ Uploaded the dashboard
  ✓ Turned off the workers.dev address (the dashboard is only at your domain)
  ✓ Connected https://usage.example.com
  ✓ Registered this machine
  … Waiting for https://usage.example.com to come online (new addresses can take a few minutes)
  ✓ https://usage.example.com is online
  ✓ Saved this machine's settings
  ✓ Background sync every 30 minutes (Task Scheduler: "ccunified sync (you)")
  … Uploading this machine's usage history
  ✓ Uploaded this machine's history (42 day(s) with usage)
```

- **Coming online** usually takes one to five minutes, while Cloudflare
  publishes the DNS record and issues the HTTPS certificate. The wizard waits
  up to 15 minutes. If the dashboard still isn't answering by then, setup
  finishes anyway; uploads keep retrying until it does.
- **On Linux**, the wizard may ask whether to keep syncing while you're logged
  out, which can ask for your sudo password once. See
  [Add machines](adding-machines.md#linux-keep-syncing-while-logged-out).
- **If a step fails partway**, the wizard offers to remove what it created, so
  you can fix the problem and run `ccunified setup` again.

## 5. Log in

Open your dashboard's address (for example `https://usage.example.com`) and log
in with the admin account you just created. Two things worth doing now:

- **Turn on two-factor login** on the **Your account** page (click your
  username at the top right). See [Using the dashboard](dashboard.md#your-account).
- **Delete the Cloudflare token** in Cloudflare (**My Profile › API Tokens**).
  The commands that change the dashboard later (`ccunified server …`) ask for
  a new one.

Next: [add your other machines](adding-machines.md).

## What's on your Cloudflare account now

| What | Name | Where to see it in Cloudflare |
|---|---|---|
| The dashboard | Worker `ccunified` | Workers & Pages › ccunified |
| Its address | your subdomain, e.g. `usage.example.com` | Workers & Pages › ccunified › Domains (the DNS record has the type *Worker*) |
| Its database | D1 database `ccunified` | Storage & Databases › D1 |

The Worker's `*.workers.dev` address is turned off, so the dashboard is only
reachable at your own subdomain. To delete all of it, run
`ccunified server remove` (see the [command reference](commands.md#ccunified-server-remove)).
