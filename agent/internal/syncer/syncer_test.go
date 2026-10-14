package syncer

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
)

// fakeUsage returns Claude Code usage on the given dates, and Codex usage on
// codexDates, filtered like ccusage --since.
type fakeUsage struct {
	dates      []string
	codexDates []string
	models     int
	// tools > 1 adds usage from that many tools on every date.
	tools   int
	warning string
	calls   []ccusage.Options
}

func (f *fakeUsage) Daily(_ context.Context, opts ccusage.Options) (*ccusage.Report, error) {
	f.calls = append(f.calls, opts)
	r := &ccusage.Report{Sources: []string{"claude"}}
	if opts.AllTools && f.warning == "" {
		r.Sources = nil
		for _, t := range ccusage.Tools {
			r.Sources = append(r.Sources, t.ID)
		}
	}
	r.Warning = f.warning
	add := func(date, source string) {
		if (opts.Since != "" && date < opts.Since) || !slices.Contains(r.Sources, source) {
			return
		}
		day := ccusage.Day{Date: date, Source: source}
		n := f.models
		if n == 0 {
			n = 1
		}
		for i := 0; i < n; i++ {
			day.Models = append(day.Models, ccusage.ModelUsage{
				Model: fmt.Sprintf("%s-model-%02d-with-a-fairly-long-name-to-take-up-space", source, i), InputTokens: 10, OutputTokens: 20,
				CacheCreationTokens: 30, CacheReadTokens: 40, CostUSD: 0.01,
			})
		}
		r.Days = append(r.Days, day)
	}
	for _, d := range f.dates {
		add(d, "claude")
		for i := 1; i < f.tools; i++ {
			add(d, ccusage.Tools[i].ID)
		}
	}
	for _, d := range f.codexDates {
		add(d, "codex")
	}
	slices.SortStableFunc(r.Days, func(a, b ccusage.Day) int { return strings.Compare(a.Date, b.Date) })
	return r, nil
}

// fakeDashboard records uploads and answers with scripted errors first. It
// accepts the upload formats in formats (default 1 and 2); legacy plays a
// dashboard from ccunified 0.1, which doesn't say which formats it accepts.
type fakeDashboard struct {
	timezone     string
	errs         []error
	uploads      []*payload.Payload
	formats      []int
	legacy       bool
	healthErr    error
	healthChecks int
}

func (f *fakeDashboard) accepted() []int {
	if f.legacy {
		return []int{1}
	}
	if f.formats == nil {
		return []int{1, 2}
	}
	return f.formats
}

func (f *fakeDashboard) HealthInfo(context.Context) (*client.HealthInfo, error) {
	f.healthChecks++
	if f.healthErr != nil {
		return nil, f.healthErr
	}
	return &client.HealthInfo{OK: true, Version: "0.2.0", SchemaVersions: f.accepted()}, nil
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
	if !slices.Contains(f.accepted(), p.SchemaVersion) {
		return nil, &client.APIError{Status: 400, Code: "invalid_request"}
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	f.uploads = append(f.uploads, p)
	latest := "0.2.0"
	res := &client.IngestResult{OK: true, ChangedRows: len(p.Days), Timezone: f.timezone, LatestVersion: &latest}
	if !f.legacy {
		res.SchemaVersions = f.accepted()
	}
	return res, nil
}

// synced is the state of a machine that already uploaded its history.
func synced() *config.State {
	return &config.State{BackfillTimezone: "UTC", BackfillFormat: 2, UploadFormat: 2}
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
	if state.BackfillTimezone != "UTC" || state.BackfillFormat != 2 || state.UploadFormat != 2 ||
		state.LatestVersion != "0.2.0" || state.LastError != "" || fmt.Sprint(state.Tools) != "[claude]" {
		t.Fatalf("state: %+v", state)
	}
}

func TestLaterSyncsResendTheLastSevenDays(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-09-01", 44)}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, synced())
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
	s, _ := newSyncer(&fakeUsage{}, dash, synced())
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
	state := synced()
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
	s, slept := newSyncer(&fakeUsage{}, dash, synced())
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
	s, slept := newSyncer(&fakeUsage{}, dash, synced())
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatalf("should recover after two failures: %v", err)
	}
	if fmt.Sprint(*slept) != "[1s 2s]" {
		t.Fatalf("backoff: %v", *slept)
	}

	dash = &fakeDashboard{timezone: "UTC", errs: []error{down, down, down, down, down, down}}
	state := synced()
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
		s, slept := newSyncer(&fakeUsage{}, dash, synced())
		if _, err := s.Run(context.Background()); !errors.Is(err, tc.want) || len(*slept) != 0 {
			t.Fatalf("got %v after %v", err, *slept)
		}
	}
}

func TestLargeUploadsAreSplit(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-10-08", 7), models: 50}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, synced())
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
	s, _ := newSyncer(usage, dash, synced())
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

func TestFirstSyncAsksWhichFormatsTheDashboardAccepts(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-10-10"}, codexDates: []string{"2026-10-12"}}
	dash := &fakeDashboard{timezone: "UTC"}
	state := &config.State{}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if dash.healthChecks != 1 || !usage.calls[0].AllTools || res.Format != 2 || fmt.Sprint(res.Tools) != "[claude codex]" {
		t.Fatalf("checks=%d calls=%+v result=%+v", dash.healthChecks, usage.calls, res)
	}
	u := dash.uploads[0]
	if u.SchemaVersion != 2 || len(u.Sources) != len(ccusage.Tools) || len(u.Days) != 2 || u.Days[1].Source != "codex" {
		t.Fatalf("upload: %+v", u)
	}
	if fmt.Sprint(state.Tools) != "[claude codex]" || state.UploadFormat != 2 || state.BackfillFormat != 2 {
		t.Fatalf("state: %+v", state)
	}
	// Later syncs don't ask again.
	if _, err := s.Run(context.Background()); err != nil || dash.healthChecks != 1 || dash.uploads[1].Range.From != "2026-10-08" {
		t.Fatalf("second sync: checks=%d uploads=%+v err=%v", dash.healthChecks, dash.uploads, err)
	}
}

func TestOldDashboardGetsClaudeCodeOnly(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-10-10"}, codexDates: []string{"2026-10-12"}}
	dash := &fakeDashboard{timezone: "UTC", legacy: true}
	state := &config.State{}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if usage.calls[0].AllTools || res.Format != 1 || state.UploadFormat != 1 || state.BackfillFormat != 1 {
		t.Fatalf("calls=%+v result=%+v state=%+v", usage.calls, res, state)
	}
	if u := dash.uploads[0]; u.SchemaVersion != 1 || u.Sources != nil || len(u.Days) != 1 || u.Days[0].Source != "claude" {
		t.Fatalf("upload: %+v", u)
	}
}

func TestUpdatedDashboardGetsTheWholeHistoryOfEveryTool(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-03-01", "2026-10-13"}, codexDates: []string{"2026-05-05"}}
	dash := &fakeDashboard{timezone: "UTC"}
	// The machine uploaded Claude Code only while the dashboard was older.
	state := &config.State{BackfillTimezone: "UTC", BackfillFormat: 1, UploadFormat: 1}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// One regular format 1 upload, whose answer says format 2 is accepted now;
	// then the whole history in format 2, straight away.
	if len(usage.calls) != 2 || usage.calls[0].AllTools || !usage.calls[1].AllTools || usage.calls[1].Since != "" {
		t.Fatalf("calls: %+v", usage.calls)
	}
	if dash.uploads[0].SchemaVersion != 1 || dash.uploads[1].SchemaVersion != 2 || dash.uploads[1].Range.From != "2026-03-01" {
		t.Fatalf("uploads: %+v", dash.uploads)
	}
	if !res.Full || res.Format != 2 || res.DaysWithUsage != 3 || state.BackfillFormat != 2 || state.UploadFormat != 2 {
		t.Fatalf("result=%+v state=%+v", res, state)
	}
}

func TestProgramUpdateUploadsTheHistoryOnceMore(t *testing.T) {
	// State saved by ccunified 0.1: no formats recorded.
	usage := &fakeUsage{dates: []string{"2026-03-01"}, codexDates: []string{"2026-05-05"}}
	dash := &fakeDashboard{timezone: "UTC"}
	state := &config.State{BackfillTimezone: "UTC"}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Full || res.Format != 2 || dash.uploads[0].Range.From != "2026-03-01" || len(dash.uploads) != 3 {
		t.Fatalf("result=%+v uploads=%d", res, len(dash.uploads))
	}
}

func TestUnreachableHealthCheckFallsBackToFormatOne(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-10-10"}, codexDates: []string{"2026-10-12"}}
	dash := &fakeDashboard{timezone: "UTC", healthErr: errors.New("timeout")}
	state := &config.State{}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The upload's answer says format 2 is accepted, so it goes again in format 2.
	if res.Format != 2 || state.UploadFormat != 2 || dash.uploads[len(dash.uploads)-1].SchemaVersion != 2 {
		t.Fatalf("result=%+v state=%+v", res, state)
	}
}

func TestRefusedNewFormatIsAskedAboutAgain(t *testing.T) {
	dash := &fakeDashboard{timezone: "UTC", formats: []int{1}}
	state := synced()
	s, _ := newSyncer(&fakeUsage{}, dash, state)
	if _, err := s.Run(context.Background()); err == nil {
		t.Fatal("expected the refusal to be reported")
	}
	if state.UploadFormat != 0 {
		t.Fatalf("format should be asked about again: %+v", state)
	}
	if _, err := s.Run(context.Background()); err != nil || dash.healthChecks != 1 || state.UploadFormat != 1 {
		t.Fatalf("err=%v checks=%d state=%+v", err, dash.healthChecks, state)
	}
}

func TestClaudeCodeOnlyFallbackIsReportedAndRetried(t *testing.T) {
	usage := &fakeUsage{dates: []string{"2026-10-10"}, warning: "only Claude Code's usage could be read: ccusage failed"}
	dash := &fakeDashboard{timezone: "UTC"}
	state := &config.State{BackfillTimezone: "UTC", UploadFormat: 2}
	s, _ := newSyncer(usage, dash, state)
	res, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if u := dash.uploads[0]; u.SchemaVersion != 2 || fmt.Sprint(u.Sources) != "[claude]" {
		t.Fatalf("upload: %+v", u)
	}
	if res.Warning == "" || state.LastWarning == "" || state.BackfillFormat != 0 {
		t.Fatalf("result=%+v state=%+v", res, state)
	}
	// The full history is tried again next time, and a clean sync clears the warning.
	usage.warning = ""
	if res, err := s.Run(context.Background()); err != nil || !res.Full || state.LastWarning != "" || state.BackfillFormat != 2 {
		t.Fatalf("second sync: %+v %v state=%+v", res, err, state)
	}
}

func TestManyToolsAreSplitIntoSeveralUploads(t *testing.T) {
	usage := &fakeUsage{dates: dates("2026-07-07", 100), tools: len(ccusage.Tools)}
	dash := &fakeDashboard{timezone: "UTC"}
	s, _ := newSyncer(usage, dash, &config.State{UploadFormat: 2})
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	entries := 0
	for _, u := range dash.uploads {
		if len(u.Days) > payload.MaxEntriesPerUpload {
			t.Fatalf("upload with %d entries", len(u.Days))
		}
		entries += len(u.Days)
	}
	if len(dash.uploads) < 2 || entries != 100*len(ccusage.Tools) {
		t.Fatalf("uploads=%d entries=%d", len(dash.uploads), entries)
	}
}
