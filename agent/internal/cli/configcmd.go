package cli

import (
	"context"
	"slices"
	"strconv"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
)

// OnIntervalChange is called after the sync interval changes, so the
// background schedule can follow; set by the schedule package.
var OnIntervalChange = func(minutes int) error { return nil }

func init() {
	register(&Command{
		Name:    "config",
		Summary: "Show or change this machine's settings",
		Usage:   "ccunified config show | ccunified config set interval 15|30|60",
		Run:     runConfig,
	})
}

func runConfig(_ context.Context, env *Env, args []string) error {
	if len(args) == 1 && args[0] == "show" {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		env.Printf("dashboard  %s\nmachine    %s\ntimezone   %s\ninterval   %d\n",
			cfg.DashboardURL, cfg.MachineName, cfg.Timezone, cfg.SyncIntervalMinutes)
		return nil
	}
	if len(args) == 3 && args[0] == "set" && args[1] == "interval" {
		minutes, err := strconv.Atoi(args[2])
		if err != nil || !slices.Contains(config.ValidIntervals, minutes) {
			return &UsageError{Msg: "interval must be 15, 30 or 60 (minutes)"}
		}
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		cfg.SyncIntervalMinutes = minutes
		if err := cfg.Save(); err != nil {
			return err
		}
		if err := OnIntervalChange(minutes); err != nil {
			return err
		}
		env.Printf("This machine now uploads every %d minutes.\n", minutes)
		return nil
	}
	return &UsageError{Msg: "unknown config command"}
}
