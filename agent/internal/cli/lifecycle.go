package cli

import (
	"context"
	"errors"
	"fmt"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/install"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/schedule"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/update"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

func init() {
	register(&Command{
		Name:    "update",
		Summary: "Install the latest version of ccunified on this machine",
		Usage:   "ccunified update [--check] [--force]",
		Run:     runUpdate,
	})
	register(&Command{
		Name:    "uninstall",
		Summary: "Remove ccunified from this machine (the dashboard is not affected)",
		Usage:   "ccunified uninstall [--yes] [--all-users]",
		Run:     runUninstall,
	})
}

func runUpdate(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("update", env)
	check := fs.Bool("check", false, "only check whether an update is available")
	force := fs.Bool("force", false, "reinstall even if this version is current")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := install.ExeDir()
	if err != nil {
		return err
	}
	u := update.New(dir)
	rel, err := u.Latest(ctx)
	if err != nil {
		return err
	}
	cmp, comparable := update.Compare(rel.Version, version.Version)
	switch {
	case !comparable && !*force:
		env.Printf("This is a development build (%s). The latest release is %s; run with --force to install it.\n", version.Version, rel.Version)
		return nil
	case comparable && cmp <= 0 && !*force:
		env.Printf("ccunified %s is up to date.\n", version.Version)
		return nil
	case *check:
		env.Printf("Version %s is available (this machine has %s). Run: ccunified update\n", rel.Version, version.Version)
		return nil
	}
	env.Printf("Downloading ccunified %s…\n", rel.Version)
	archive, err := u.Download(ctx, rel)
	if err != nil {
		return err
	}
	files, err := update.Files(archive, u.GOOS)
	if err != nil {
		return err
	}
	if err := u.Install(files); err != nil {
		return err
	}
	got, err := u.InstalledVersion(ctx)
	if err != nil {
		return fmt.Errorf("the new version was installed but doesn't start: %w", err)
	}
	config.Log("updated %s -> %s", version.Version, rel.Version)
	env.Printf("Installed: %s\n", got)
	// Re-create the schedule so it uses the new program's settings.
	if sys, err := config.LoadSystem(); err == nil && install.SameDir(dir, install.SystemDir()) {
		if _, err := schedulerForAll().Install(ctx, sys.SyncIntervalMinutes); err != nil {
			env.Printf("Note: couldn't refresh the background schedule: %v\n", err)
		}
	} else if cfg, err := config.Load(); err == nil {
		if s, err := schedule.Default(); err == nil && s.Current(ctx).Installed {
			if _, err := s.Install(ctx, cfg.SyncIntervalMinutes); err != nil {
				env.Printf("Note: couldn't refresh the background schedule: %v\n", err)
			}
		}
	}
	env.Printf("To update the dashboard itself, run: ccunified server update\n")
	return nil
}

func runUninstall(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("uninstall", env)
	yes := fs.Bool("yes", false, "don't ask for confirmation")
	allUsers := fs.Bool("all-users", false, "remove a system-wide install (needs root or an administrator)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	p := prompt.New(env.Stdin, env.Stdout)
	cfg, cfgErr := config.Load()
	if sys, err := config.LoadSystem(); err == nil && (*allUsers || errors.Is(cfgErr, config.ErrNotConfigured)) {
		if !profiles.Privileged() {
			return errors.New("ccunified is installed for all users here; removing it needs root (sudo) or an administrator's elevated window")
		}
		if !*yes {
			env.Printf("This removes ccunified for every user account on this computer: the\n")
			env.Printf("background sync, every account's settings and the program itself. The\n")
			env.Printf("dashboard and the usage it already has are not affected.\n")
			ok, err := p.Confirm("Uninstall for all users?", false)
			if err != nil {
				return err
			}
			if !ok {
				return nil
			}
		}
		uninstallAllUsers(ctx, env, sys)
		return nil
	} else if *allUsers {
		return err
	}
	if !*yes {
		env.Printf("This removes ccunified from this machine: the background sync, its settings\n")
		env.Printf("(including its upload key) and the program itself. The dashboard and the\n")
		env.Printf("usage it already has are not affected.\n")
		ok, err := p.Confirm("Uninstall?", false)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
	}
	if s, err := schedule.Default(); err == nil {
		if err := s.Remove(ctx); err != nil {
			env.Printf("  ! Couldn't remove the background sync: %v\n", err)
		} else {
			env.Printf("  ✓ Removed the background sync\n")
		}
	}
	if err := config.Remove(); err != nil {
		env.Printf("  ! Couldn't remove the settings: %v\n", err)
	} else {
		env.Printf("  ✓ Removed this machine's settings\n")
	}
	dir, err := install.ExeDir()
	if err == nil && install.SameDir(dir, install.DefaultDir()) {
		if err := install.RemoveProgram(dir); err != nil {
			env.Printf("  ! Couldn't remove the program files in %s: %v\n", dir, err)
		} else {
			env.Printf("  ✓ Removed the program\n")
		}
	} else if err == nil {
		env.Printf("  The program in %s was left in place (not a standard install).\n", dir)
	}
	if cfgErr == nil {
		env.Printf("\n%q still appears on %s with its past usage. To stop it\n", cfg.MachineName, cfg.DashboardURL)
		env.Printf("from ever uploading again, revoke it on the dashboard's Machines page.\n")
	} else if !errors.Is(cfgErr, config.ErrNotConfigured) {
		env.Printf("\n(The old settings couldn't be read: %v)\n", cfgErr)
	}
	return nil
}
