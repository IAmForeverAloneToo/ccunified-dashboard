package syncer

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
)

// fakeUsage returns usage on the given dates, filtered like ccusage --since.
type fakeUsage struct {
	dates  []string
	models int
	calls  []ccusage.Options
}

func (f *fakeUsage) Daily(_ context.Context, opts ccusage.Options) (*ccusage.Report, error) {
	f.calls = append(f.calls, opts)
	r := &ccusage.Report{}
	for _, d := range f.dates {
		if opts.Since != "" && d < opts.Since {
			continue
		}
		day := ccusage.Day{Date: d}
		n := f.models
		if n == 0 {
			n = 1
		}
		for i := 0; i < n; i++ {
			day.Models = append(day.Models, ccusage.ModelUsage{
				Model: fmt.Sprintf("claude-model-%02d-with-a-fairly-long-name-to-take-up-space", i), InputTokens: 10, OutputTokens: 20,
				CacheCreationTokens: 30, CacheReadTokens: 40, CostUSD: 0.01,
			})
		}
		r.Days = append(r.Days, day)
	}
	return r, nil
}

// fakeDashboard records uploads and answers with scripted errors first.
type fakeDashboard struct {
	timezone string
	errs     []error
	uploads  []*payload.Payload
}

func (f *fakeDashboard) Ingest(_ context.Context, p *payload.Payload) (*client.IngestResult, error) {
	if len(f.errs) > 0 {
		err := f.errs[0]
		f.errs = f.errs[1:]
		if err != nil {
			return nil, err
		}
	}
	if p.Timezone != f.timezone {
		return nil, &client.APIError{Status: 409, Code: "timezone_mismatch", Body: map[string]any{"error": "timezone_mismatch", "timezone": f.timezone}}
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	f.uploads = append(f.uploads, p)
	latest := "0.2.0"
	return &client.IngestResult{OK: true, ChangedRows: len(p.Days), Timezone: f.timezone, LatestVersion: &latest}, nil
}

var now = time.Date(2026, 10, 14, 15, 0, 0, 0, time.UTC)

func newSyncer(usage *fakeUsage, dash *fakeDashboard, state *config.State) (*Syncer, *[]time.Duration) {
	var slept []time.Duration
	return &Syncer{
		Config:   &config.Config{Timezone: "UTC", SyncIntervalMinutes: 30},
		State:    state,
		Usage:    usage,
		Uploader: dash,
		Now:      func() time.Time { return now },
		Sleep: func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			return nil
		},
	}, &slept
}

func dates(from string, n int) []string {
	var out []string
	for i := 0; i < n; i++ {
		out = append(out, addDays(from, i))
	}
	return out
}

func TestFirstSyncUploadsWholeHistoryInChunks(t *testing.T) {
	usage := &fakeUsage{dates: append(dates("2026-01-01", 3), "2026-10-14")}
	dash := &fakeDashboard{timezone: "UTC"}
	state := &config.State{}
	s, _ := newSyncer(usage, dash, state)

	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if usage.calls[0].Since != "" {
		t.Errorf("first sync must read all history, got since=%q", usage.calls[0].Since)
	}
	// 2026-01-01 .. 2026-10-14 is 287 days: three uploads of at most 100 days, back to back.
	if len(dash.uploads) != 3 || !res.Full || res.DaysWithUsage != 4 {
		t.Fatalf("uploads=%d result=%+v", len(dash.uploads), res)
	}
	want := "2026-01-01"
	for _, u := range dash.uploads {
		if u.Range.From != want {
			t.Fatalf("ranges not contiguous: got %s, want %s", u.Range.From, want)
		}
		if daysBetween(u.Range.From, u.Range.To) > payload.MaxRangeDays {
			t.Fatalf("range too long: %+v", u.Range)
		}
		want = addDays(u.Range.To, 1)
	}
	if last := dash.uploads[2].Range.To; last != "2026-10-14" {
		t.Fatalf("history must end today, got %s", last)
	}
	if state.BackfillTimezone != "UTC" || state.LatestVersion != "0.2.0" || state.LastError != "" {
		t.Fatalf("state: %+v", state)
	}
}

func TestLaterSyncsResendTheLastSevenDays(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-09-01", 44)}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, &config.State{BackfillTimezone: "UTC"})
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if usage.calls[0].Since != "2026-10-08" {
		t.Errorf("since = %q", usage.calls[0].Since)
	}
	if len(dash.uploads) != 1 || dash.uploads[0].Range != (payload.Range{From: "2026-10-08", To: "2026-10-14"}) {
		t.Fatalf("uploads: %+v", dash.uploads)
	}
	if res.Full || res.DaysWithUsage != 7 {
		t.Fatalf("result: %+v", res)
	}
}

func TestNoUsageStillUploadsTheRange(t *testing.T) {
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(&fakeUsage{}, dash, &config.State{BackfillTimezone: "UTC"})
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	// An empty upload clears any rows the dashboard has for those days.
	if len(dash.uploads) != 1 || len(dash.uploads[0].Days) != 0 {
		t.Fatalf("uploads: %+v", dash.uploads)
	}
}

func TestTimezoneChangeOnTheDashboardTriggersFullReupload(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-10-01", 14)}
	dash := &fakeDashboard{timezone: "Asia/Tehran"}
	state := &config.State{BackfillTimezone: "UTC"}
	s, _ := newSyncer(usage, dash, state)
	var saved string
	s.OnTimezoneChange = func(tz string) error { saved = tz; return nil }

	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if saved != "Asia/Tehran" || s.Config.Timezone != "Asia/Tehran" {
		t.Fatalf("time zone not adopted: saved=%q config=%q", saved, s.Config.Timezone)
	}
	if last := usage.calls[len(usage.calls)-1]; last.Timezone != "Asia/Tehran" || last.Since != "" {
		t.Fatalf("expected a full re-read in the new zone, got %+v", last)
	}
	if !res.Full || state.BackfillTimezone != "Asia/Tehran" || dash.uploads[0].Range.From != "2026-10-01" {
		t.Fatalf("result=%+v state=%+v", res, state)
	}
}

func TestRateLimitIsWaitedOut(t *testing.T) {
	dash := &fakeDashboard{timezone: "UTC", errs: []error{&client.APIError{Status: 429, Code: "too_many_requests", RetryAfter: time.Second}}}
	s, slept := newSyncer(&fakeUsage{}, dash, &config.State{BackfillTimezone: "UTC"})
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*slept) != 1 || (*slept)[0] != time.Second || len(dash.uploads) != 1 {
		t.Fatalf("slept=%v uploads=%d", *slept, len(dash.uploads))
	}
}

func TestNetworkTroubleIsRetriedThenReported(t *testing.T) {
	down := errors.New("connection refused")
	dash := &fakeDashboard{timezone: "UTC", errs: []error{down, &client.APIError{Status: 503}, nil}}
	s, slept := newSyncer(&fakeUsage{}, dash, &config.State{BackfillTimezone: "UTC"})
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatalf("should recover after two failures: %v", err)
	}
	if fmt.Sprint(*slept) != "[1s 2s]" {
		t.Fatalf("backoff: %v", *slept)
	}

	dash = &fakeDashboard{timezone: "UTC", errs: []error{down, down, down, down, down, down}}
	state := &config.State{BackfillTimezone: "UTC"}
	s, slept = newSyncer(&fakeUsage{}, dash, state)
	_, err := s.Run(context.Background())
	if !errors.Is(err, ErrUnreachable) {
		t.Fatalf("want ErrUnreachable, got %v", err)
	}
	if fmt.Sprint(*slept) != "[1s 2s 4s 8s 16s]" || !strings.Contains(state.LastError, "couldn't reach") {
		t.Fatalf("slept=%v state=%+v", *slept, state)
	}
}

func TestRevokedMachineStopsImmediately(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want error
	}{
		{&client.APIError{Status: http.StatusUnauthorized, Code: "machine_revoked"}, ErrRevoked},
		{&client.APIError{Status: http.StatusUnauthorized, Code: "invalid_token"}, ErrBadToken},
	} {
		dash := &fakeDashboard{timezone: "UTC", errs: []error{tc.err}}
		s, slept := newSyncer(&fakeUsage{}, dash, &config.State{BackfillTimezone: "UTC"})
		if _, err := s.Run(context.Background()); !errors.Is(err, tc.want) || len(*slept) != 0 {
			t.Fatalf("got %v after %v", err, *slept)
		}
	}
}

func TestLargeUploadsAreSplit(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-10-08", 7), models: 50}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, &config.State{BackfillTimezone: "UTC"})
	usage.dates = dates("2026-07-07", 100)
	s.State.BackfillTimezone = ""
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(dash.uploads) < 2 {
		t.Fatalf("expected the 100-day, 50-model history to be split, got %d upload(s)", len(dash.uploads))
	}
	days := 0
	for _, u := range dash.uploads {
		days += len(u.Days)
	}
	if days != 100 {
		t.Fatalf("lost days while splitting: %d", days)
	}
}

func TestClockAheadKeepsFutureDates(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-10-15"}}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, &config.State{BackfillTimezone: "UTC"})
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := dash.uploads[0].Range.To; got != "2026-10-15" || len(dash.uploads[0].Days) != 1 {
		t.Fatalf("range %+v days %d", dash.uploads[0].Range, len(dash.uploads[0].Days))
	}
}

func TestChunks(t *testing.T) {
	got := chunks("2026-01-01", "2026-01-05", 2)
	if fmt.Sprint(got) != "[[2026-01-01 2026-01-02] [2026-01-03 2026-01-04] [2026-01-05 2026-01-05]]" {
		t.Fatal(got)
	}
}
