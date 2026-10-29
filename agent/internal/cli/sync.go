package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/enroll"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prices"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/syncer"
)

func init() {
	register(&Command{
		Name:    "sync",
		Summary: "Upload this machine's usage now (the background schedule runs this)",
		Usage:   "ccunified sync [--full] [--quiet] [--all-users]",
		Run:     runSync,
	})
}

// errNoUsageYet means an account of a system-wide install has no usage
// yet, so it hasn't asked to join.
var errNoUsageYet = errors.New("no usage on this account yet")

// RunSync performs one sync with the saved configuration. If this machine
// is waiting for approval to join, it asks the dashboard first (and returns
// enroll.ErrWaiting while it waits).
func RunSync(ctx context.Context, full bool) (res *syncer.Result, err error) {
	// Problems before the sync itself (which records its own outcome) are
	// logged and shown by `ccunified status` too.
	started := false
	defer func() {
		switch {
		case started || err == nil || errors.Is(err, config.ErrNotConfigured) || errors.Is(err, errNoUsageYet):
		case errors.Is(err, enroll.ErrWaiting):
			config.RecordAttempt(time.Now(), nil) // asking the dashboard worked
		default:
			config.Log("sync failed: %v", err)
			config.RecordAttempt(time.Now(), err)
		}
	}()
	account := accountFromEnv()
	if account == nil {
		if _, err := config.Load(); errors.Is(err, config.ErrNotConfigured) {
			if _, err := config.LoadPending(); errors.Is(err, config.ErrNoPending) {
				return nil, config.ErrNotConfigured
			}
		}
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
	if account != nil {
		runner.Env = profiles.Env(os.Environ(), *account)
		// ccusage runs as the account (never as root or SYSTEM).
		as, err := ccusage.LogOn(ccusage.Account{UID: account.UID, GID: account.GID,
			SID: account.SID, Domain: account.Domain, User: account.User})
		if err != nil {
			config.Log("sync failed: %v", err)
			return nil, err
		}
		defer as.Close()
		runner.AsUser = as
	}
	cfg, err := connect(ctx, runner, account)
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
	started = true
	res, runErr := s.Run(ctx)
	if runErr == nil {
		reportPrices(ctx, cfg, state)
	}
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

// connect returns this machine's settings. Without any, it follows up on a
// request to join that waits for approval; an account of a system-wide
// install that has usage asks to join first.
func connect(ctx context.Context, runner *ccusage.Runner, account *profiles.Profile) (*config.Config, error) {
	cfg, err := config.Load()
	if !errors.Is(err, config.ErrNotConfigured) {
		return cfg, err
	}
	pend, err := config.LoadPending()
	if err == nil {
		return enroll.Check(ctx, pend)
	}
	if !errors.Is(err, config.ErrNoPending) || account == nil {
		return nil, config.ErrNotConfigured
	}
	sys, err := config.LoadSystem()
	if err != nil {
		return nil, err
	}
	// Only accounts that use a coding tool join (not every account on the computer).
	report, err := runner.Daily(ctx, ccusage.Options{Timezone: "UTC", AllTools: true, Offline: true})
	if err != nil {
		return nil, err
	}
	if len(report.Days) == 0 {
		return nil, errNoUsageYet
	}
	name := profiles.MachineName(profiles.Hostname(), *account)
	if _, err := enroll.Request(ctx, sys.DashboardURL, sys.EnrollKey, name, sys.SyncIntervalMinutes, time.Now()); err != nil {
		return nil, err
	}
	return nil, enroll.ErrWaiting
}

func runSync(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("sync", env)
	full := fs.Bool("full", false, "upload the whole history, not just the last 7 days")
	quiet := fs.Bool("quiet", false, "print nothing (used by the background schedule)")
	allUsers := fs.Bool("all-users", false, "sync every user account (a system-wide install; needs root or SYSTEM)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return &UsageError{Msg: "unexpected arguments"}
	}
	if *allUsers {
		return syncAllUsers(ctx, env, *full, *quiet)
	}
	res, err := RunSync(ctx, *full)
	switch {
	case errors.Is(err, enroll.ErrWaiting):
		if !*quiet {
			if pend, err := config.LoadPending(); err == nil {
				env.Printf("Waiting for approval on %s as %q.\n", pend.DashboardURL, pend.MachineName)
			} else {
				env.Printf("Waiting for approval on the dashboard.\n")
			}
		}
		return nil
	case errors.Is(err, errNoUsageYet):
		if !*quiet {
			env.Printf("No usage on this account yet; it asks to join once there is some.\n")
		}
		return nil
	case err != nil:
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

// reportPrices sends the dashboard its models' prices from the public price
// lists, for its "price lists" pricing, at most once a day. Problems are only
// logged: they never fail a sync, and the next sync tries again.
func reportPrices(ctx context.Context, cfg *config.Config, state *config.State) {
	now := time.Now()
	if now.Sub(state.PricesReportedAt) < prices.MaxAge {
		return
	}
	dir, err := config.Dir()
	if err != nil {
		return
	}
	f := &prices.Fetcher{Dir: filepath.Join(dir, "prices")}
	n, err := prices.Report(ctx, client.New(cfg.DashboardURL, cfg.Token), f.Load)
	switch {
	case client.IsCode(err, http.StatusNotFound, "not_found"):
		// A dashboard from before ccunified 0.5: ask again tomorrow.
		state.PricesReportedAt = now
	case err != nil:
		config.Log("prices not sent: %v", err)
	default:
		state.PricesReportedAt = now
		config.Log("prices sent for %d model(s)", n)
	}
}
