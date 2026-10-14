package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/cloudflare"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/login"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

// Names of the Cloudflare resources a dashboard is made of.
const (
	WorkerName   = "ccunified"
	DatabaseName = "ccunified"
)

// Account, Zone and Domain come from the Cloudflare API.
type (
	Account = cloudflare.Account
	Zone    = cloudflare.Zone
	Domain  = cloudflare.Domain
)

// Cloudflare is everything setup needs from the Cloudflare API.
type Cloudflare interface {
	Accounts(ctx context.Context) ([]Account, error)
	Zones(ctx context.Context, accountID string) ([]Zone, error)
	// FindDatabase returns the ID of the D1 database with this name, or "".
	FindDatabase(ctx context.Context, accountID, name string) (string, error)
	CreateDatabase(ctx context.Context, accountID, name string) (string, error)
	D1(accountID, databaseID string) server.D1
	// WorkerExists reports whether a Worker script with this name exists.
	WorkerExists(ctx context.Context, accountID, name string) (bool, error)
	UploadWorker(ctx context.Context, accountID, name string, module []byte, databaseID string) error
	DisableWorkersDev(ctx context.Context, accountID, name string) error
	// HostnameInUse reports whether a DNS record already exists for hostname.
	HostnameInUse(ctx context.Context, zoneID, hostname string) (bool, error)
	AttachDomain(ctx context.Context, accountID, zoneID, hostname, worker string) error
	// Domains lists the custom domains attached to a Worker.
	Domains(ctx context.Context, accountID, worker string) ([]Domain, error)
	DeleteDomain(ctx context.Context, accountID, domainID string) error
	DeleteWorker(ctx context.Context, accountID, name string) error
	DeleteDatabase(ctx context.Context, accountID, databaseID string) error
}

// CloudflareFactory makes a Cloudflare client for a pasted API token.
type CloudflareFactory func(token string) Cloudflare

// Assets supplies the Worker and migrations built into this program.
type Assets struct {
	Worker     func() ([]byte, error)
	Migrations func() ([]server.Migration, error)
}

// tokenPermissions are the API token permissions setup needs, as the
// Cloudflare dashboard names them, with the keys of its token template link.
var tokenPermissions = []struct{ Label, Key, Type string }{
	{"Account > Workers Scripts > Edit", "workers_scripts", "edit"},
	{"Account > D1 > Edit", "d1", "edit"},
	{"Account > Account Settings > Read", "account_settings", "read"},
	{"Zone > Workers Routes > Edit", "workers_routes", "edit"},
	{"Zone > Zone > Read", "zone", "read"},
	{"Zone > DNS > Read", "dns", "read"},
}

// TokenTemplateURL opens Cloudflare's "create token" page with the
// permissions filled in.
func TokenTemplateURL() string {
	type key struct {
		Key  string `json:"key"`
		Type string `json:"type"`
	}
	keys := make([]key, len(tokenPermissions))
	for i, p := range tokenPermissions {
		keys[i] = key{p.Key, p.Type}
	}
	b, _ := json.Marshal(keys)
	q := url.Values{"permissionGroupKeys": {string(b)}, "accountId": {"*"}, "zoneId": {"all"}, "name": {"ccunified setup"}}
	return "https://dash.cloudflare.com/profile/api-tokens?" + q.Encode()
}

// TokenHelp explains how to create the API token the wizard needs.
func TokenHelp() string {
	var b strings.Builder
	b.WriteString("To create the dashboard, ccunified needs a Cloudflare API token. It is\n")
	b.WriteString("used only while this setup runs and is never saved.\n\n")
	b.WriteString("Open this link to create one with the right permissions filled in:\n\n  ")
	b.WriteString(TokenTemplateURL())
	b.WriteString("\n\nCheck that it lists exactly these permissions (add any that are missing):\n")
	for _, p := range tokenPermissions {
		b.WriteString("  " + p.Label + "\n")
	}
	b.WriteString("Then click \"Continue to summary\", \"Create Token\", and copy the token.\n")
	return b.String()
}

var subdomainRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Create sets up a new dashboard on the user's Cloudflare account and
// connects this machine to it.
func Create(ctx context.Context, p *prompt.Prompter, h *Hooks, factory CloudflareFactory) error {
	return create(ctx, p, h, factory, defaultAssets())
}

func create(ctx context.Context, p *prompt.Prompter, h *Hooks, factory CloudflareFactory, assets Assets) error {
	module, err := assets.Worker()
	if err != nil {
		return err
	}
	migrations, err := assets.Migrations()
	if err != nil {
		return err
	}

	p.Printf("\nCreate a new dashboard\n\n")
	p.Printf("This creates, on your Cloudflare account (the free plan is enough):\n")
	p.Printf("  - a database (D1) and the dashboard itself (a Worker), both named %q\n", WorkerName)
	p.Printf("  - a subdomain of your domain, like usage.example.com; Cloudflare adds its\n")
	p.Printf("    DNS record and HTTPS certificate, so you don't need a server or IP address\n")
	p.Printf("Your domain must already be on Cloudflare with the status Active.\n")
	p.Printf("Nothing is created until you confirm at the end.\n\n%s\n", TokenHelp())
	var cf Cloudflare
	var accounts []Account
	if _, err := p.Secret("Paste the API token (it won't be shown)", func(token string) error {
		cf = factory(token)
		checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		list, err := cf.Accounts(checkCtx)
		var apiErr *cloudflare.APIError
		if errors.As(err, &apiErr) {
			return fmt.Errorf("Cloudflare didn't accept that token: %v\n"+
				"  Copy the token itself (it's shown once, after \"Create Token\"), and if you\n"+
				"  set a TTL, check that it starts today. Paste a new token to try again", err)
		}
		if err != nil {
			return fmt.Errorf("couldn't reach Cloudflare to check the token: %v", err)
		}
		if len(list) == 0 {
			return errors.New("that token can't see any Cloudflare account; check its permissions")
		}
		accounts = list
		return nil
	}); err != nil {
		return err
	}

	account := accounts[0]
	if len(accounts) > 1 {
		names := make([]string, len(accounts))
		for i, a := range accounts {
			names[i] = a.Name
		}
		i, err := p.Choose("\nWhich Cloudflare account?", names, -1)
		if err != nil {
			return err
		}
		account = accounts[i]
	}

	if id, err := cf.FindDatabase(ctx, account.ID, DatabaseName); err != nil {
		return fmt.Errorf("couldn't list D1 databases: %w", err)
	} else if id != "" {
		return fmt.Errorf("this Cloudflare account already has a ccunified dashboard (database %q). "+
			"To update it run: ccunified server update. To connect this machine to it, run setup again and choose \"Join\"", DatabaseName)
	}
	if exists, err := cf.WorkerExists(ctx, account.ID, WorkerName); err != nil {
		return fmt.Errorf("couldn't list Workers: %w", err)
	} else if exists {
		return fmt.Errorf("this Cloudflare account already has a Worker called %q; remove it or use another account", WorkerName)
	}

	zones, err := cf.Zones(ctx, account.ID)
	if err != nil {
		return fmt.Errorf("couldn't list your domains: %w", err)
	}
	if len(zones) == 0 {
		return errors.New("the token can't see any active domain. The dashboard needs a domain on this " +
			"Cloudflare account with the status Active (its nameservers pointing to Cloudflare); a newly added " +
			"domain becomes Active once Cloudflare sees the nameserver change. Also check that the token " +
			"includes Zone > Zone > Read for it")
	}
	zone := zones[0]
	if len(zones) > 1 {
		names := make([]string, len(zones))
		for i, z := range zones {
			names[i] = z.Name
		}
		i, err := p.Choose("\nWhich domain should the dashboard use?", names, -1)
		if err != nil {
			return err
		}
		zone = zones[i]
	} else {
		p.Printf("\nThe dashboard will use your domain %s.\n", zone.Name)
	}

	var hostname string
	if _, err := p.Text(fmt.Sprintf("Subdomain for the dashboard (…%s)", "."+zone.Name), "usage", func(s string) error {
		s = strings.ToLower(strings.TrimSpace(s))
		if !subdomainRe.MatchString(s) {
			return errors.New("use letters, digits and dashes only, like \"usage\"")
		}
		hostname = s + "." + zone.Name
		inUse, err := cf.HostnameInUse(ctx, zone.ID, hostname)
		if err != nil {
			return fmt.Errorf("couldn't check %s: %v", hostname, err)
		}
		if inUse {
			return fmt.Errorf("%s is already in use (it has a DNS record). Choose another subdomain", hostname)
		}
		return nil
	}); err != nil {
		return err
	}

	tz, err := askTimezone(p)
	if err != nil {
		return err
	}

	p.Printf("\nNow create the dashboard's first admin account. You'll log in with it,\n")
	p.Printf("and can add more people from the dashboard later.\n")
	username, err := p.Text("Admin username", "admin", func(s string) error {
		if !regexp.MustCompile(`^[A-Za-z0-9._-]{3,32}$`).MatchString(s) {
			return errors.New("use 3-32 letters, digits, dots, dashes or underscores")
		}
		return nil
	})
	if err != nil {
		return err
	}
	password, err := p.NewPassword(fmt.Sprintf("Password (at least %d characters)", login.MinPasswordLength), func(s string) error {
		return login.CheckNewPassword(s, username)
	})
	if err != nil {
		return err
	}

	p.Printf("\nAnd this machine:\n")
	machineName, err := p.Text("Name for this machine on the dashboard", defaultMachineName(), ValidMachineName)
	if err != nil {
		return err
	}
	interval, err := askInterval(p)
	if err != nil {
		return err
	}

	url := "https://" + hostname
	p.Printf("\nReady to create:\n")
	p.Printf("  Dashboard:   %s  (Cloudflare account %q)\n", url, account.Name)
	p.Printf("  Time zone:   %s\n", tz)
	p.Printf("  Admin:       %s\n", username)
	p.Printf("  This machine: %s, uploading every %d minutes\n\n", machineName, interval)
	ok, err := p.Confirm("Create it now?", true)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("setup cancelled; nothing was created")
	}

	step := func(done string, err error) error {
		if err != nil {
			p.Printf("  ✗ %s\n", done)
			return err
		}
		p.Printf("  ✓ %s\n", done)
		return nil
	}
	p.Printf("\n")
	dbID, err := cf.CreateDatabase(ctx, account.ID, DatabaseName)
	if err := step("Created the database", err); err != nil {
		return fmt.Errorf("creating the D1 database: %w", err)
	}
	// If anything below fails, offer to remove what was created, so setup
	// can simply be run again.
	created := &createdResources{account: account.ID, databaseID: dbID}
	if err := buildDashboard(ctx, p, cf, created, buildOptions{
		module: module, migrations: migrations, tz: tz, username: username, password: password,
		zone: zone, hostname: hostname, step: step,
	}); err != nil {
		created.offerRollback(ctx, p, cf)
		return err
	}
	db := cf.D1(account.ID, dbID)
	machineID, token, err := server.RegisterMachine(ctx, db, machineName, runtime.GOOS, runtime.GOARCH, version.Version, interval)
	if err := step("Registered this machine", err); err != nil {
		return err
	}

	p.Printf("  … Waiting for %s to come online (new addresses can take a few minutes)\n", url)
	if err := waitOnline(ctx, h, url, hostname); err != nil {
		p.Printf("  ! %s isn't answering yet. It usually starts within 15 minutes;\n", url)
		p.Printf("    uploads will retry until it does.\n")
	} else {
		p.Printf("  ✓ %s is online\n", url)
	}

	cfg := &config.Config{
		DashboardURL:        url,
		MachineID:           machineID,
		MachineName:         strings.TrimSpace(machineName),
		Token:               token,
		Timezone:            tz,
		SyncIntervalMinutes: interval,
	}
	if err := finish(ctx, p, h, cfg); err != nil {
		return err
	}
	p.Printf("\nDone! Open %s and log in as %q.\n", url, username)
	p.Printf("To add another machine, install ccunified there and choose \"Join an existing dashboard\".\n")
	p.Printf("The Cloudflare token was not saved; you can delete it now if you like.\n")
	return nil
}

// waitOnline polls the dashboard's health endpoint for up to 15 minutes.
// It first waits until public DNS has the new hostname: a lookup made before
// that would leave this computer's (or its router's) DNS remembering
// "doesn't exist" for up to half an hour, even after the dashboard is up.
func waitOnline(ctx context.Context, h *Hooks, url, host string) error {
	check := h.CheckOnline
	if check == nil {
		check = func(ctx context.Context, url string) error {
			_, err := client.New(url, "").Health(ctx)
			return err
		}
	}
	deadline := h.now().Add(15 * time.Minute)
	for h.Published != nil && h.now().Before(deadline) {
		found, err := h.Published(ctx, host)
		if err != nil || found {
			break // public DNS unreachable: just check the dashboard
		}
		if err := h.sleep(ctx, 5*time.Second); err != nil {
			return err
		}
	}
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := check(checkCtx, url)
		cancel()
		if err == nil {
			return nil
		}
		if !h.now().Before(deadline) {
			return err
		}
		if err := h.sleep(ctx, 10*time.Second); err != nil {
			return err
		}
	}
}

type createdResources struct {
	account    string
	databaseID string
	worker     bool
	domainHost string
}

type buildOptions struct {
	module             []byte
	migrations         []server.Migration
	tz                 string
	username, password string
	zone               Zone
	hostname           string
	step               func(string, error) error
}

// buildDashboard fills the new database and puts the Worker online.
func buildDashboard(ctx context.Context, p *prompt.Prompter, cf Cloudflare, created *createdResources, o buildOptions) error {
	db := cf.D1(created.account, created.databaseID)
	_, err := server.ApplyMigrations(ctx, db, o.migrations)
	if err := o.step("Set up the database tables", err); err != nil {
		return err
	}
	if err := o.step("Set the time zone to "+o.tz, server.SetTimezone(ctx, db, o.tz)); err != nil {
		return err
	}
	if err := o.step(fmt.Sprintf("Created the admin account %q", o.username), server.CreateAdmin(ctx, db, o.username, o.password)); err != nil {
		return err
	}
	err = cf.UploadWorker(ctx, created.account, WorkerName, o.module, created.databaseID)
	if err := o.step("Uploaded the dashboard", err); err != nil {
		return fmt.Errorf("uploading the Worker: %w", err)
	}
	created.worker = true
	if err := o.step("Turned off the workers.dev address (the dashboard is only at your domain)", cf.DisableWorkersDev(ctx, created.account, WorkerName)); err != nil {
		return err
	}
	if err := o.step("Connected https://"+o.hostname, cf.AttachDomain(ctx, created.account, o.zone.ID, o.hostname, WorkerName)); err != nil {
		return fmt.Errorf("connecting %s: %w", o.hostname, err)
	}
	created.domainHost = o.hostname
	return nil
}

// offerRollback removes a half-built dashboard if the user agrees.
func (c *createdResources) offerRollback(ctx context.Context, p *prompt.Prompter, cf Cloudflare) {
	p.Printf("\nSetup stopped partway. ")
	ok, err := p.Confirm("Remove what was created on Cloudflare, so you can run setup again?", true)
	if err != nil || !ok {
		p.Printf("Left in place. To remove it later, run: ccunified server remove\n")
		return
	}
	if c.domainHost != "" {
		if domains, err := cf.Domains(ctx, c.account, WorkerName); err == nil {
			for _, d := range domains {
				cf.DeleteDomain(ctx, c.account, d.ID)
			}
		}
	}
	if c.worker {
		if err := cf.DeleteWorker(ctx, c.account, WorkerName); err != nil {
			p.Printf("  ! Couldn't delete the Worker: %v\n", err)
		}
	}
	if err := cf.DeleteDatabase(ctx, c.account, c.databaseID); err != nil {
		p.Printf("  ! Couldn't delete the database: %v\n", err)
		return
	}
	p.Printf("  ✓ Removed. You can run ccunified setup again.\n")
}
