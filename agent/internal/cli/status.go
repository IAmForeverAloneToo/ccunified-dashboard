package cli

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

func init() {
	register(&Command{
		Name:    "status",
		Summary: "Show this machine's dashboard, last upload and schedule",
		Usage:   "ccunified status",
		Run:     runStatus,
	})
	register(&Command{
		Name:    "version",
		Summary: "Show the program version",
		Usage:   "ccunified version",
		Run: func(_ context.Context, env *Env, _ []string) error {
			env.Printf("ccunified %s (ccusage %s)\n", version.Version, ccusage.Version())
			return nil
		},
	})
}

// ScheduleStatus describes the background schedule; set by the schedule package.
var ScheduleStatus = func() string { return "not set up" }

func ago(t time.Time, now time.Time) string {
	if t.IsZero() {
		return "never"
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d minute(s) ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hour(s) ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%d day(s) ago", int(d.Hours()/24))
	}
}

// toolList names the tools a machine has reported usage for, in ccusage's order.
func toolList(ids []string) string {
	if len(ids) == 0 {
		return "no usage found on this machine yet"
	}
	var names []string
	for _, t := range ccusage.Tools {
		if slices.Contains(ids, t.ID) {
			names = append(names, t.Name)
		}
	}
	for _, id := range ids {
		if ccusage.ToolName(id) == id {
			names = append(names, id)
		}
	}
	return strings.Join(names, ", ")
}

func runStatus(_ context.Context, env *Env, args []string) error {
	if len(args) > 0 {
		return &UsageError{Msg: "unexpected arguments"}
	}
	dir, _ := config.Dir()
	logPath, _ := config.LogPath()
	env.Printf("ccunified %s\n\n", version.Version)
	cfg, err := config.Load()
	if errors.Is(err, config.ErrNotConfigured) {
		env.Printf("This machine isn't connected to a dashboard yet. Run: ccunified setup\n")
		return nil
	}
	if err != nil {
		return err
	}
	state := config.LoadState()
	now := time.Now()
	row := func(label, value string) { env.Printf("  %-13s %s\n", label+":", value) }
	row("Dashboard", cfg.DashboardURL)
	row("Machine", cfg.MachineName)
	row("Time zone", cfg.Timezone)
	row("Sync every", fmt.Sprintf("%d minutes", cfg.SyncIntervalMinutes))
	row("Schedule", ScheduleStatus())

	last := ago(state.LastSuccessAt, now)
	if !state.LastSuccessAt.IsZero() {
		last += fmt.Sprintf(" (%d day(s) with usage, %d row(s) changed)", state.LastDays, state.LastChanged)
	}
	row("Last upload", last)
	if state.LastError != "" && state.LastAttemptAt.After(state.LastSuccessAt) {
		row("Last problem", fmt.Sprintf("%s: %s", ago(state.LastAttemptAt, now), state.LastError))
	}
	if state.LastWarning != "" && !state.LastSuccessAt.IsZero() {
		row("Note", state.LastWarning)
	}
	row("Tools", toolList(state.Tools))
	if state.UploadFormat == payload.SchemaV1 {
		row("Other tools", "the dashboard accepts Claude Code usage only; to add the other tools, run: ccunified server update")
	}
	if state.LatestVersion != "" && state.LatestVersion != version.Version {
		row("Update", fmt.Sprintf("version %s is available; run: ccunified update", state.LatestVersion))
	}

	integrity := "ok"
	if runner, err := ccusage.Locate(); err != nil {
		integrity = err.Error()
	} else if runner.Verify {
		if err := runner.CheckIntegrity(); err != nil {
			integrity = err.Error()
		}
	} else {
		integrity = "not verified (development override)"
	}
	row("ccusage", fmt.Sprintf("%s, %s", ccusage.Version(), integrity))
	row("Settings", dir)
	row("Log", logPath)
	return nil
}
