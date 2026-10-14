package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/syncer"
)

func init() {
	register(&Command{
		Name:    "sync",
		Summary: "Upload this machine's usage now (the background schedule runs this)",
		Usage:   "ccunified sync [--full] [--quiet]",
		Run:     runSync,
	})
}

// RunSync performs one sync with the saved configuration.
func RunSync(ctx context.Context, full bool) (*syncer.Result, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	unlock, err := config.Lock()
	if err != nil {
		return nil, err
	}
	defer unlock()

	runner, err := ccusage.Locate()
	if err != nil {
		return nil, err
	}
	state := config.LoadState()
	// CCUNIFIED_CCUSAGE_OFFLINE=1 makes ccusage use its built-in price list
	// instead of fetching current prices (tests, offline machines).
	runner.Offline = os.Getenv("CCUNIFIED_CCUSAGE_OFFLINE") == "1"
	s := &syncer.Syncer{
		Config:   cfg,
		State:    state,
		Usage:    runner,
		Uploader: client.New(cfg.DashboardURL, cfg.Token),
		Full:     full,
		OnTimezoneChange: func(tz string) error {
			config.Log("dashboard time zone is now %s; uploading full history again", tz)
			return cfg.Save()
		},
	}
	res, runErr := s.Run(ctx)
	if err := state.Save(); err != nil && runErr == nil {
		runErr = err
	}
	if runErr != nil {
		config.Log("sync failed: %v", runErr)
		return res, runErr
	}
	config.Log("sync ok: %s..%s, %d upload(s), %d day(s) with usage, %d row(s) changed%s",
		res.From, res.To, res.Uploads, res.DaysWithUsage, res.ChangedRows, map[bool]string{true: " (full history)"}[res.Full])
	return res, nil
}

func runSync(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("sync", env)
	full := fs.Bool("full", false, "upload the whole history, not just the last 7 days")
	quiet := fs.Bool("quiet", false, "print nothing (used by the background schedule)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return &UsageError{Msg: "unexpected arguments"}
	}
	res, err := RunSync(ctx, *full)
	if err != nil {
		return err
	}
	if *quiet {
		return nil
	}
	if res.Warning != "" {
		env.Printf("Note: %s\n", res.Warning)
	}
	if res.Full && res.DaysWithUsage == 0 {
		env.Printf("No usage found on this machine yet. Uploaded an empty report; usage appears after you use Claude Code (or another tool ccusage reads) here.\n")
		return nil
	}
	what := "the last 7 days"
	if res.Full {
		what = fmt.Sprintf("the full history (%s to %s)", res.From, res.To)
	}
	env.Printf("Uploaded %s: %d day(s) with usage, %d row(s) changed on the dashboard.\n", what, res.DaysWithUsage, res.ChangedRows)
	if len(res.Tools) > 0 {
		env.Printf("Tools: %s\n", toolList(res.Tools))
	}
	if res.Format == payload.SchemaV1 {
		env.Printf("The dashboard accepts Claude Code usage only. To add the other tools, run: ccunified server update\n")
	}
	return nil
}
