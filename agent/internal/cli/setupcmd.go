package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/cloudflare"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/schedule"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/setup"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

var _ setup.Cloudflare = (*cloudflare.Client)(nil)

func cloudflareFactory(token string) setup.Cloudflare {
	c := cloudflare.New(token)
	c.UserAgent = "ccunified/" + version.Version
	if u := os.Getenv("CCUNIFIED_CLOUDFLARE_API"); u != "" {
		c.BaseURL = u // tests and local rehearsals only
	}
	return c
}

func init() {
	register(&Command{
		Name:    "setup",
		Summary: "Create a new dashboard, or connect this machine to an existing one",
		Usage:   "ccunified setup [--no-schedule | --schedule-only]",
		Run:     runSetup,
	})
	register(&Command{
		Name:    "server",
		Summary: "Update, recover or remove the dashboard on Cloudflare (needs a Cloudflare API token)",
		Usage:   "ccunified server update | server reset-password [username] | server remove",
		Run:     runServer,
	})
	ScheduleStatus = func() string {
		s, err := schedule.Default()
		if err != nil {
			return err.Error()
		}
		return s.Current(context.Background()).String()
	}
	OnIntervalChange = func(minutes int) error {
		ctx := context.Background()
		s, err := schedule.Default()
		if err != nil || !s.Current(ctx).Installed {
			return nil // nothing scheduled yet; setup will use the new interval
		}
		if _, err := installSchedule(ctx, nil, minutes); err != nil {
			return fmt.Errorf("the interval was saved, but the background schedule couldn't be updated: %w", err)
		}
		return nil
	}
}

// installSchedule sets up the background sync. With a prompter, on Linux it
// also offers to keep the timer running while the user is logged out.
func installSchedule(ctx context.Context, p *prompt.Prompter, minutes int) (string, error) {
	s, err := schedule.Default()
	if err != nil {
		return "", err
	}
	desc, err := s.Install(ctx, minutes)
	if err != nil {
		return "", err
	}
	if p != nil && s.UsesSystemd(ctx) && !s.LingerEnabled(ctx) {
		p.Printf("\nOn Linux, background syncs stop while you're logged out, unless\n")
		p.Printf("\"lingering\" is turned on for your account (this may ask for your sudo password).\n")
		yes, err := p.Confirm("Keep syncing while you're logged out?", true)
		if err != nil {
			return "", err
		}
		if yes {
			if err := s.EnableLinger(ctx, true); err != nil {
				p.Printf("  ! %v\n", err)
			} else {
				desc += ", also while logged out"
			}
		}
	}
	config.Log("schedule: %s", desc)
	return desc, nil
}

func hooks(p *prompt.Prompter) *setup.Hooks {
	return &setup.Hooks{
		InstallSchedule: func(cfg *config.Config) (string, error) {
			return installSchedule(context.Background(), p, cfg.SyncIntervalMinutes)
		},
		Published: func(ctx context.Context, host string) (bool, error) {
			addrs, err := client.LookupPublic(ctx, host)
			return len(addrs) > 0, err
		},
		FirstSync: func(ctx context.Context) (string, error) {
			res, err := RunSync(ctx, true)
			if err != nil {
				return "", err
			}
			if res.NoClaudeData {
				return "Connected. No Claude Code logs on this machine yet; usage appears after you use it here", nil
			}
			return fmt.Sprintf("Uploaded this machine's history (%d day(s) with usage)", res.DaysWithUsage), nil
		},
	}
}

func runSetup(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("setup", env)
	scheduleOnly := fs.Bool("schedule-only", false, "only (re)install the background sync")
	noSchedule := fs.Bool("no-schedule", false, "don't set up the background sync (run ccunified sync yourself)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *scheduleOnly && *noSchedule {
		return &UsageError{Msg: "use either --no-schedule or --schedule-only, not both"}
	}
	p := prompt.New(env.Stdin, env.Stdout)
	if *scheduleOnly {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		desc, err := installSchedule(ctx, p, cfg.SyncIntervalMinutes)
		if err != nil {
			return err
		}
		env.Printf("%s\n", desc)
		return nil
	}
	h := hooks(p)
	if *noSchedule {
		h.InstallSchedule = nil
	}
	return setup.Run(ctx, p, h, cloudflareFactory)
}

func runServer(ctx context.Context, env *Env, args []string) error {
	if len(args) == 0 {
		return &UsageError{Msg: "missing server command"}
	}
	p := prompt.New(env.Stdin, env.Stdout)
	switch args[0] {
	case "update":
		if len(args) != 1 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerUpdate(ctx, p, cloudflareFactory)
	case "reset-password":
		user := ""
		if len(args) == 2 {
			user = args[1]
		} else if len(args) > 2 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerResetPassword(ctx, p, cloudflareFactory, user)
	case "remove":
		if len(args) != 1 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerRemove(ctx, p, cloudflareFactory)
	}
	return &UsageError{Msg: fmt.Sprintf("unknown server command %q", args[0])}
}
