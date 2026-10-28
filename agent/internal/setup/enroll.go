package setup

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/enroll"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
)

// EnrollOptions are the answers a script gives instead of the wizard's
// questions (see `ccunified setup --enroll-key`).
type EnrollOptions struct {
	URL string
	Key string
	// Name is this machine's name on the dashboard (default: the hostname).
	// Unused for all users: each account is "HOST (user)".
	Name string
	// Interval is how often to sync, in minutes (default 30).
	Interval int
}

func (o *EnrollOptions) check(ctx context.Context, h *Hooks) (string, error) {
	url, err := config.NormalizeURL(o.URL)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(o.Key, "ccu_e_") {
		return "", errors.New("that isn't an enrollment key (they start with ccu_e_); create one on the dashboard's Machines page")
	}
	if o.Interval == 0 {
		o.Interval = 30
	}
	if config.ValidateInterval(o.Interval) != nil {
		return "", errors.New("the sync interval must be 15, 30 or 60 minutes")
	}
	if o.Name == "" {
		o.Name = defaultMachineName()
	}
	if err := ValidMachineName(o.Name); err != nil {
		return "", fmt.Errorf("machine name: %w", err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if h.CheckOnline != nil {
		err = h.CheckOnline(checkCtx, url)
	} else {
		_, err = client.New(url, "").Health(checkCtx)
	}
	if err != nil {
		return "", fmt.Errorf("no ccunified dashboard answered at %s. Check the address, and that the dashboard is set up", url)
	}
	return url, nil
}

// EnrollUser connects this account to a dashboard with an enrollment key,
// asking no questions: it asks to join, sets up the background sync, and
// returns. An admin then approves the machine on the dashboard, and the
// next sync after that starts uploading. Running it again changes nothing.
func EnrollUser(ctx context.Context, p *prompt.Prompter, h *Hooks, o EnrollOptions) error {
	url, err := o.check(ctx, h)
	if err != nil {
		return err
	}
	if cfg, err := config.Load(); err == nil {
		if cfg.DashboardURL != url {
			return fmt.Errorf("this machine already uploads to %s; to switch dashboards, run ccunified uninstall first", cfg.DashboardURL)
		}
		p.Printf("This machine already uploads to %s as %q.\n", cfg.DashboardURL, cfg.MachineName)
		return nil
	}
	if pend, err := config.LoadPending(); err == nil && pend.DashboardURL == url && pend.Status == "waiting" {
		cfg, err := enroll.Check(ctx, pend)
		switch {
		case errors.Is(err, enroll.ErrWaiting):
			p.Printf("This machine is waiting for approval on %s as %q (asked %s).\n",
				url, pend.MachineName, pend.RequestedAt.Local().Format("2006-01-02 15:04"))
			installUserSchedule(p, h, pend.SyncIntervalMinutes)
			return nil
		case err == nil:
			p.Printf("Approved: this machine is %q on %s.\n", cfg.MachineName, url)
			installUserSchedule(p, h, cfg.SyncIntervalMinutes)
			firstSync(ctx, p, h)
			return nil
		}
		// Denied or expired: ask again.
	}
	pend, err := enroll.Request(ctx, url, o.Key, strings.TrimSpace(o.Name), o.Interval, h.now())
	if err != nil {
		return err
	}
	p.Printf("Asked %s to add this machine as %q.\n", url, pend.MachineName)
	installUserSchedule(p, h, o.Interval)
	p.Printf("An admin approves it on the dashboard's Approvals page. Its usage is\n")
	p.Printf("uploaded at the first sync after that (syncs run every %d minutes).\n", o.Interval)
	return nil
}

func installUserSchedule(p *prompt.Prompter, h *Hooks, interval int) {
	if h.InstallSchedule == nil {
		p.Printf("  - No background sync was set up; run \"ccunified sync\" once it's approved.\n")
		return
	}
	desc, err := h.InstallSchedule(&config.Config{SyncIntervalMinutes: interval})
	if err != nil {
		p.Printf("  ! Couldn't set up the background sync: %v\n", err)
		return
	}
	p.Printf("  ✓ %s\n", desc)
}

func firstSync(ctx context.Context, p *prompt.Prompter, h *Hooks) {
	if h.FirstSync == nil {
		return
	}
	msg, err := h.FirstSync(ctx)
	if err != nil {
		p.Printf("  ! The first upload didn't work: %v (it will be retried)\n", err)
		return
	}
	p.Printf("  ✓ %s\n", msg)
}

// AllUsersHooks connect EnrollAllUsers to the rest of the program.
type AllUsersHooks struct {
	// InstallProgram copies the program to where every account can run it
	// and returns its path.
	InstallProgram func() (string, error)
	// InstallSchedule sets up the sync of every account, as SYSTEM or root.
	InstallSchedule func(exe string, minutes int) (string, error)
	// SyncAll runs the first sync of every account and reports on each.
	SyncAll func(ctx context.Context, exe string) (string, error)
}

// EnrollAllUsers sets ccunified up for every user account on this computer
// (run as root or SYSTEM): each account with usage asks to join as its own
// machine, "HOST (user)", now and whenever a new one appears.
func EnrollAllUsers(ctx context.Context, p *prompt.Prompter, h *Hooks, ah AllUsersHooks, o EnrollOptions) error {
	url, err := o.check(ctx, h)
	if err != nil {
		return err
	}
	if err := enroll.CheckKey(ctx, url, o.Key); err != nil {
		return err
	}
	if old, err := config.LoadSystem(); err == nil && old.DashboardURL != url {
		return fmt.Errorf("this computer is already set up for all users with %s; to switch dashboards, run ccunified uninstall first", old.DashboardURL)
	}
	sys := &config.System{DashboardURL: url, EnrollKey: o.Key, SyncIntervalMinutes: o.Interval}
	if err := sys.Save(); err != nil {
		return fmt.Errorf("couldn't save the settings in %s: %w", config.SystemDir(), err)
	}
	p.Printf("  ✓ Saved the settings for all users in %s\n", config.SystemDir())
	exe, err := ah.InstallProgram()
	if err != nil {
		return fmt.Errorf("couldn't install the program for all users: %w", err)
	}
	p.Printf("  ✓ Installed the program in %s\n", exe)
	if ah.InstallSchedule != nil {
		desc, err := ah.InstallSchedule(exe, o.Interval)
		if err != nil {
			p.Printf("  ! Couldn't set up the background sync: %v\n", err)
		} else {
			p.Printf("  ✓ %s\n", desc)
		}
	}
	if ah.SyncAll != nil {
		summary, err := ah.SyncAll(ctx, exe)
		if summary != "" {
			p.Printf("%s", summary)
		}
		if err != nil {
			p.Printf("  ! %v\n", err)
		}
	}
	p.Printf("Each account with usage asks to join %s as \"%s (user)\".\n", url, defaultMachineName())
	p.Printf("An admin approves them on the dashboard's Approvals page; their usage is\n")
	p.Printf("uploaded at the first sync after that (syncs run every %d minutes).\n", o.Interval)
	return nil
}
