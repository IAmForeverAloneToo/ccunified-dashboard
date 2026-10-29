package setup

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/login"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/update"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

// runningVersion asks a dashboard which version it runs (replaced in tests).
var runningVersion = func(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return client.New(url, "").Health(ctx)
}

// installation is an existing dashboard found on a Cloudflare account.
type installation struct {
	cf         Cloudflare
	account    Account
	databaseID string // "" for a Worker left without its database
	domains    []Domain
}

// findInstallation asks for a token and locates the dashboard's resources.
// With workerOnly, a ccunified Worker without a database (left by a setup
// that stopped partway) counts too, so that it can be removed.
func findInstallation(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory, why string, workerOnly bool) (*installation, error) {
	var inst *installation
	err := ask(ctx, func() (err error) {
		inst, err = locateInstallation(ctx, p, factory, why, workerOnly)
		return err
	})
	return inst, err
}

func locateInstallation(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory, why string, workerOnly bool) (*installation, error) {
	p.Printf("%s needs a Cloudflare API token with the same permissions as setup.\n", why)
	p.Printf("It is used only now and never saved. A token from earlier that hasn't\n")
	p.Printf("expired works too.\n\n%s\n", tokenSteps("ccunified server"))
	var cf Cloudflare
	var accounts []Account
	if _, err := p.Secret("Paste the API token (it won't be shown)", func(token string) error {
		cf = factory(token)
		checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		list, err := cf.Accounts(checkCtx)
		if err != nil {
			return fmt.Errorf("Cloudflare didn't accept that token: %v", err)
		}
		if len(list) == 0 {
			return errors.New("that token can't see any Cloudflare account")
		}
		accounts = list
		return nil
	}); err != nil {
		return nil, err
	}
	// Use the account that has the dashboard; ask only if several do.
	var found []*installation
	for _, a := range accounts {
		id, err := cf.FindDatabase(ctx, a.ID, DatabaseName)
		if err != nil {
			return nil, fmt.Errorf("couldn't list D1 databases in %q: %w", a.Name, err)
		}
		if id != "" {
			found = append(found, &installation{cf: cf, account: a, databaseID: id})
		}
	}
	if len(found) == 0 && workerOnly {
		for _, a := range accounts {
			exists, err := cf.WorkerExists(ctx, a.ID, WorkerName)
			if err != nil {
				return nil, fmt.Errorf("couldn't list Workers in %q: %w", a.Name, err)
			}
			if exists {
				found = append(found, &installation{cf: cf, account: a})
			}
		}
	}
	if len(found) == 0 {
		return nil, errors.New("no ccunified dashboard was found in the Cloudflare account(s) this token can see")
	}
	inst := found[0]
	if len(found) > 1 {
		names := make([]string, len(found))
		for i, f := range found {
			names[i] = f.account.Name
		}
		i, err := p.Choose("Several accounts have a dashboard. Which one?", names, -1)
		if err != nil {
			return nil, err
		}
		inst = found[i]
	}
	domains, err := cf.Domains(ctx, inst.account.ID, WorkerName)
	if err != nil {
		return nil, fmt.Errorf("couldn't list the dashboard's domains: %w", err)
	}
	inst.domains = domains
	return inst, nil
}

func (i *installation) address() string {
	if len(i.domains) == 0 {
		return "(no address attached)"
	}
	return "https://" + i.domains[0].Hostname
}

// ServerUpdate applies new migrations and uploads this program's version of
// the dashboard. With force, it goes ahead even when it can't check which
// version the dashboard runs.
func ServerUpdate(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory, force bool) error {
	return serverUpdate(ctx, p, factory, defaultAssets(), force)
}

func serverUpdate(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory, assets Assets, force bool) error {
	module, err := assets.Worker()
	if err != nil {
		return err
	}
	migrations, err := assets.Migrations()
	if err != nil {
		return err
	}
	inst, err := findInstallation(ctx, p, factory, "Updating the dashboard", false)
	if err != nil {
		return err
	}
	db := inst.cf.D1(inst.account.ID, inst.databaseID)
	// Never replace a newer dashboard with this program's older one: its
	// database may already have changes the older dashboard doesn't know.
	// The database tells for sure, even when the dashboard doesn't answer.
	unknown, err := server.UnknownMigrations(ctx, db, migrations)
	if err != nil {
		return fmt.Errorf("couldn't read the dashboard's database: %w", err)
	}
	if len(unknown) > 0 {
		return fmt.Errorf("this dashboard is newer than this ccunified (%s): its database has changes "+
			"this version doesn't know (%s). Run ccunified update first, then ccunified server update again",
			version.Version, strings.Join(unknown, ", "))
	}
	newer, unsure := checkRunningVersion(ctx, inst)
	if newer != nil {
		return newer
	}
	if unsure != nil {
		if !force {
			return fmt.Errorf("%w. If you're sure this ccunified is at least as new as the dashboard, "+
				"run: ccunified server update --force", unsure)
		}
		p.Printf("\n  ! %v; going ahead (--force)\n", unsure)
	}
	p.Printf("\nUpdating the dashboard at %s (account %q)\n", inst.address(), inst.account.Name)
	applied, err := server.ApplyMigrations(ctx, db, migrations)
	if err != nil {
		return err
	}
	if len(applied) == 0 {
		p.Printf("  ✓ Database already up to date\n")
	} else {
		p.Printf("  ✓ Updated the database (%s)\n", strings.Join(applied, ", "))
	}
	if err := inst.cf.UploadWorker(ctx, inst.account.ID, WorkerName, module, inst.databaseID); err != nil {
		return fmt.Errorf("uploading the dashboard: %w", err)
	}
	p.Printf("  ✓ Uploaded the new dashboard\n")
	if err := inst.cf.DisableWorkersDev(ctx, inst.account.ID, WorkerName); err != nil {
		return err
	}
	p.Printf("  ✓ workers.dev address is off\n\nDone.\n")
	return nil
}

// checkRunningVersion asks the dashboard which version it runs and compares
// it with this program's. newer is set if the dashboard is newer, unsure if
// it couldn't tell.
func checkRunningVersion(ctx context.Context, inst *installation) (newer, unsure error) {
	if len(inst.domains) == 0 {
		return nil, errors.New("couldn't check which version the dashboard runs: it has no address attached")
	}
	running, err := runningVersion(ctx, inst.address())
	if err != nil {
		return nil, fmt.Errorf("couldn't check which version the dashboard runs: %v", err)
	}
	c, ok := update.Compare(running, version.Version)
	if !ok {
		return nil, fmt.Errorf("couldn't compare the dashboard's version (%s) with this program's (%s)", running, version.Version)
	}
	if c > 0 {
		return fmt.Errorf("the dashboard runs ccunified %s, which is newer than this program (%s). "+
			"Run ccunified update first, then ccunified server update again", running, version.Version), nil
	}
	return nil, nil
}

// userLabel names a user and their dashboard-wide role, if any, for a list.
func userLabel(u map[string]any) string {
	role, _ := u["role"].(string)
	if role == "" {
		role = "department roles only"
	}
	return fmt.Sprintf("%v (%s)", u["username"], role)
}

// ServerResetPassword sets a new password for a dashboard user, for an admin who is locked out.
func ServerResetPassword(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory, username string) error {
	inst, err := findInstallation(ctx, p, factory, "Resetting a password", false)
	if err != nil {
		return err
	}
	db := inst.cf.D1(inst.account.ID, inst.databaseID)
	var password string
	var clear2FA bool
	if err := ask(ctx, func() error {
		if username == "" {
			users, err := server.ListUsers(ctx, db)
			if err != nil {
				return err
			}
			if len(users) == 0 {
				return errors.New("the dashboard has no users")
			}
			names := make([]string, len(users))
			for i, u := range users {
				names[i] = userLabel(u)
			}
			i, err := p.Choose("\nWhose password?", names, -1)
			if err != nil {
				return err
			}
			username, _ = users[i]["username"].(string)
		}
		var err error
		password, err = p.NewPassword(fmt.Sprintf("New password for %s (at least %d characters)", username, login.MinPasswordLength),
			func(s string) error { return login.CheckNewPassword(s, username) })
		if err != nil {
			return err
		}
		clear2FA, err = p.Confirm("Also turn off two-factor for this user (if they lost their authenticator)?", false)
		return err
	}); err != nil {
		return err
	}
	if err := server.ResetPassword(ctx, db, username, password, clear2FA); err != nil {
		return err
	}
	p.Printf("\n  ✓ New password set for %s. Their sessions were signed out", username)
	if clear2FA {
		p.Printf(" and two-factor is off")
	}
	p.Printf(".\n")
	return nil
}

// ServerRemove deletes the dashboard from Cloudflare: its address, the Worker
// and the database. It also removes a Worker left without its database by a
// setup that stopped partway.
func ServerRemove(ctx context.Context, p *prompt.Prompter, factory CloudflareFactory) error {
	inst, err := findInstallation(ctx, p, factory, "Removing the dashboard", true)
	if err != nil {
		return err
	}
	if inst.databaseID == "" {
		p.Printf("\nAccount %q has a dashboard Worker at %s but no database,\n", inst.account.Name, inst.address())
		p.Printf("probably left by a setup that stopped partway. This deletes the Worker.\n")
	} else {
		p.Printf("\nThis permanently deletes the dashboard at %s (account %q),\n", inst.address(), inst.account.Name)
		p.Printf("including all usage history and user accounts. It can't be undone.\n")
	}
	confirm := WorkerName
	if len(inst.domains) > 0 {
		confirm = inst.domains[0].Hostname
	}
	if err := ask(ctx, func() error {
		_, err := p.Text(fmt.Sprintf("Type %s to confirm", confirm), "", func(s string) error {
			if s != confirm {
				return fmt.Errorf("that doesn't match %s", confirm)
			}
			return nil
		})
		return err
	}); err != nil {
		return err
	}
	for _, d := range inst.domains {
		if err := inst.cf.DeleteDomain(ctx, inst.account.ID, d.ID); err != nil {
			return fmt.Errorf("removing %s: %w", d.Hostname, err)
		}
		p.Printf("  ✓ Removed %s\n", d.Hostname)
	}
	if err := inst.cf.DeleteWorker(ctx, inst.account.ID, WorkerName); err != nil {
		return fmt.Errorf("deleting the Worker: %w", err)
	}
	p.Printf("  ✓ Deleted the dashboard Worker\n")
	if inst.databaseID == "" {
		p.Printf("\nThe leftover Worker is gone. You can run ccunified setup again.\n")
		return nil
	}
	if err := inst.cf.DeleteDatabase(ctx, inst.account.ID, inst.databaseID); err != nil {
		return fmt.Errorf("deleting the database: %w", err)
	}
	p.Printf("  ✓ Deleted the database\n\nThe dashboard is gone. To remove ccunified from a machine, run there: ccunified uninstall\n")
	return nil
}
