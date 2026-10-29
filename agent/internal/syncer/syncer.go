// Package syncer reads this machine's usage with ccusage and uploads it to
// the dashboard.
//
// The first sync (and the first after the dashboard's time zone changes)
// uploads the whole history still on disk, in chunks of at most 100 days.
// Later syncs re-send the last 7 days, or every day since the last
// successful sync if that is longer ago: the dashboard replaces each
// uploaded range, so sending a day twice never counts it twice, and missed
// syncs are filled in by the next one.
//
// The dashboard keeps days whose logs are gone (Claude Code deletes its
// logs after 30 days by default). So a tool's rows are only replaced from
// the first day it has usage in what was read: an upload never clears days
// for which the tool's logs no longer exist.
//
// Usage comes from every tool ccusage reads (upload format 2). A dashboard
// from ccunified 0.1 accepts Claude Code alone (format 1); once it is updated
// and says it accepts format 2, the whole history is uploaded again with
// every tool.
package syncer

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

// RecentDays is how many days each regular sync re-sends (today included).
const RecentDays = 7

// maxPayloadBytes keeps uploads well under the dashboard's 256 KiB limit.
const maxPayloadBytes = 200 * 1024

// maxRetryAfter is the longest wait for a busy dashboard; when it asks for
// more, the sync stops and the next scheduled one tries again.
const maxRetryAfter = time.Minute

// OtherModels names the entry that adds up a day's smallest models when a
// day has more models than the dashboard accepts.
const OtherModels = "other-models"

// Usage is where the daily report comes from (ccusage, or a fake in tests).
type Usage interface {
	Daily(ctx context.Context, opts ccusage.Options) (*ccusage.Report, error)
}

// Uploader talks to the dashboard (the dashboard client, or a fake in tests).
type Uploader interface {
	Ingest(ctx context.Context, p *payload.Payload) (*client.IngestResult, error)
	HealthInfo(ctx context.Context) (*client.HealthInfo, error)
}

// Syncer runs one sync.
type Syncer struct {
	Config   *config.Config
	State    *config.State
	Usage    Usage
	Uploader Uploader
	// Now and Sleep are replaceable in tests.
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
	// Full forces uploading the whole history.
	Full bool
	// OnTimezoneChange is called after the dashboard's time zone is adopted,
	// so the caller can save the config.
	OnTimezoneChange func(tz string) error
}

// Result summarizes a sync.
type Result struct {
	Full          bool
	From, To      string
	Uploads       int
	DaysWithUsage int
	ChangedRows   int
	// Tools are the tools with usage in the uploaded range.
	Tools []string
	// Format is the upload format used (1: Claude Code only, 2: every tool).
	Format int
	// Warning is a problem the sync worked around.
	Warning       string
	LatestVersion string
}

// Friendly errors for the situations a person has to act on.
var (
	ErrRevoked     = errors.New("this machine was revoked on the dashboard; to add it again, run: ccunified setup")
	ErrBadToken    = errors.New("the dashboard didn't accept this machine's upload key; to join again, run: ccunified setup")
	ErrUnreachable = errors.New("couldn't reach the dashboard")
)

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run performs the sync and records the outcome in State.
func (s *Syncer) Run(ctx context.Context) (*Result, error) {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.Sleep == nil {
		s.Sleep = sleepCtx
	}
	s.adoptState()
	s.State.LastAttemptAt = s.Now()
	res, err := s.run(ctx, retries{})
	if err != nil {
		s.State.LastError = err.Error()
		return res, err
	}
	s.State.LastError = ""
	s.State.LastSuccessAt = s.Now()
	s.State.LastChanged = res.ChangedRows
	s.State.LastDays = res.DaysWithUsage
	s.State.LastWarning = res.Warning
	for _, t := range res.Tools {
		if !slices.Contains(s.State.Tools, t) {
			s.State.Tools = append(s.State.Tools, t)
		}
	}
	if res.LatestVersion != "" {
		s.State.LatestVersion = res.LatestVersion
	}
	return res, nil
}

// adoptState starts the state afresh when it belongs to another machine
// (setup was run again, or this machine joined another dashboard), so the
// new one uploads its whole history.
func (s *Syncer) adoptState() {
	st := s.State
	if st.MachineID != "" && (st.MachineID != s.Config.MachineID || st.DashboardURL != s.Config.DashboardURL) {
		*st = config.State{}
	}
	st.MachineID, st.DashboardURL = s.Config.MachineID, s.Config.DashboardURL
}

// retries records which restarts a sync has already made.
type retries struct{ timezone, format bool }

// newestFormat picks the newest upload format in versions that this program
// produces; dashboards that don't say accept format 1.
func newestFormat(versions []int) int {
	best := payload.SchemaV1
	for _, v := range versions {
		if v > best && v <= payload.SchemaVersion {
			best = v
		}
	}
	return best
}

// uploadFormat returns the format to upload in, asking the dashboard the
// first time.
func (s *Syncer) uploadFormat(ctx context.Context) int {
	if f := s.State.UploadFormat; f >= payload.SchemaV1 && f <= payload.SchemaVersion {
		return f
	}
	info, err := s.Uploader.HealthInfo(ctx)
	if err != nil {
		// Every dashboard accepts format 1; its answer to the upload says
		// whether it accepts more.
		return payload.SchemaV1
	}
	s.State.UploadFormat = newestFormat(info.SchemaVersions)
	return s.State.UploadFormat
}

func (s *Syncer) run(ctx context.Context, retried retries) (*Result, error) {
	tz := s.Config.Timezone
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("invalid time zone %q: %w", tz, err)
	}
	today := s.Now().In(loc).Format(time.DateOnly)
	format := s.uploadFormat(ctx)
	full := s.Full || s.State.BackfillTimezone != tz || s.State.BackfillFormat != format

	opts := ccusage.Options{Timezone: tz, AllTools: format >= payload.SchemaV2}
	from := addDays(today, -(RecentDays - 1))
	if last := s.lastSuccessDate(loc); !full && last != "" && last < from {
		if daysBetween(last, today) > payload.MaxRangeDays {
			full = true // too long since the last upload: send everything again
		} else {
			from = last // re-send every day since the last upload
		}
	}
	if !full {
		opts.Since = from
	}
	report, err := s.Usage.Daily(ctx, opts)
	if err != nil {
		return nil, err
	}
	if full {
		from = today
		if e := report.Earliest(); e != "" && e < from {
			from = e
		}
	}
	to := today
	if l := report.Latest(); l > to {
		to = l // the machine's clock runs ahead of the dashboard's zone; keep its data
	}

	sources := []string{payload.SourceClaude}
	if format >= payload.SchemaV2 {
		sources = report.Sources
	}
	starts := toolStarts(report.Days, sources, from, to, today)
	from = to
	for _, d := range starts {
		from = min(from, d)
	}

	res := &Result{Full: full, From: from, To: to, Format: format, Warning: report.Warning}
	if n := foldModels(report.Days); n > 0 {
		res.Warning = joinWarnings(res.Warning, fmt.Sprintf(
			"%d day(s) had more than %d models; the smallest were added up as %q", n, payload.MaxModelsPerDay, OtherModels))
	}
	dates := map[string]bool{}
	for _, d := range report.Days {
		if _, ok := starts[d.Source]; ok && d.Date >= from && d.Date <= to {
			dates[d.Date] = true
			if !slices.Contains(res.Tools, d.Source) {
				res.Tools = append(res.Tools, d.Source)
			}
		}
	}
	res.DaysWithUsage = len(dates)

	for _, seg := range segments(starts, sources, to) {
		payloads, err := s.build(report, seg.from, seg.to, format, seg.sources)
		if err != nil {
			return res, err
		}
		for _, p := range payloads {
			out, err := s.upload(ctx, p)
			var apiErr *client.APIError
			if errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict && apiErr.Code == "timezone_mismatch" {
				newTz := apiErr.Field("timezone")
				if retried.timezone || newTz == "" || newTz == tz {
					return res, fmt.Errorf("the dashboard keeps rejecting time zone %q", tz)
				}
				// The dashboard's days use another zone now: adopt it and
				// upload the full history again, grouped by the new zone.
				s.Config.Timezone = newTz
				if s.OnTimezoneChange != nil {
					if err := s.OnTimezoneChange(newTz); err != nil {
						return res, err
					}
				}
				s.State.BackfillTimezone = ""
				retried.timezone = true
				return s.run(ctx, retried)
			}
			if errors.As(err, &apiErr) && apiErr.Status == http.StatusBadRequest && format > payload.SchemaV1 {
				// Perhaps the dashboard went back to an older version: ask
				// it again next time.
				s.State.UploadFormat = 0
			}
			if err != nil {
				return res, err
			}
			res.Uploads++
			res.ChangedRows += out.ChangedRows
			if out.LatestVersion != nil {
				res.LatestVersion = *out.LatestVersion
			}
			if newest := newestFormat(out.SchemaVersions); newest != format {
				s.State.UploadFormat = newest
				if newest > format && !retried.format {
					// The dashboard was updated and now accepts every tool:
					// upload the whole history again in the new format.
					retried.format = true
					return s.run(ctx, retried)
				}
			}
		}
	}
	// A history that fell back to Claude Code alone isn't complete; the next
	// sync tries again.
	if full && report.Warning == "" {
		s.State.BackfillTimezone = tz
		s.State.BackfillFormat = format
	}
	return res, nil
}

// build makes the payload(s) for one date range, halving the range until
// each payload is small enough to upload.
func (s *Syncer) build(report *ccusage.Report, from, to string, format int, sources []string) ([]*payload.Payload, error) {
	p := &payload.Payload{
		SchemaVersion: format,
		Agent: payload.Agent{
			Version:             version.Version,
			OS:                  runtime.GOOS,
			Arch:                runtime.GOARCH,
			CcusageVersion:      ccusage.Version(),
			SyncIntervalMinutes: s.Config.SyncIntervalMinutes,
		},
		Timezone: s.Config.Timezone,
		Range:    payload.Range{From: from, To: to},
		Days:     []payload.Day{},
	}
	limit := payload.MaxDaysPerUpload
	if format >= payload.SchemaV2 {
		p.Sources = sources
		limit = payload.MaxEntriesPerUpload
	}
	for _, d := range report.Days {
		if d.Date < from || d.Date > to || !slices.Contains(sources, d.Source) {
			continue
		}
		day := payload.Day{Date: d.Date, Source: d.Source, Models: []payload.Model{}}
		for _, m := range d.Models {
			day.Models = append(day.Models, payload.Model{
				Model:               m.Model,
				InputTokens:         m.InputTokens,
				OutputTokens:        m.OutputTokens,
				CacheCreationTokens: m.CacheCreationTokens,
				CacheReadTokens:     m.CacheReadTokens,
				CostUSD:             m.CostUSD,
			})
		}
		p.Days = append(p.Days, day)
	}
	if len(p.Days) <= limit {
		if err := p.Validate(); err != nil {
			return nil, fmt.Errorf("internal error building the upload: %w", err)
		}
		data, err := json.Marshal(p)
		if err != nil {
			return nil, err
		}
		if len(data) <= maxPayloadBytes {
			return []*payload.Payload{p}, nil
		}
		if from == to {
			return nil, fmt.Errorf("usage for %s is too large to upload (%d bytes)", from, len(data))
		}
	} else if from == to {
		return nil, fmt.Errorf("usage for %s is too large to upload (%d entries)", from, len(p.Days))
	}
	mid := addDays(from, daysBetween(from, to)/2-1)
	left, err := s.build(report, from, mid, format, sources)
	if err != nil {
		return nil, err
	}
	right, err := s.build(report, addDays(mid, 1), to, format, sources)
	if err != nil {
		return nil, err
	}
	return append(left, right...), nil
}

// upload sends one payload, waiting and retrying on rate limits (as long as
// the dashboard asks, up to a minute) and on network or server trouble (1,
// 2, 4, 8 then 16 seconds apart).
func (s *Syncer) upload(ctx context.Context, p *payload.Payload) (*client.IngestResult, error) {
	backoff := time.Second
	const attempts = 6
	var lastErr error
	for i := 0; i < attempts; i++ {
		out, err := s.Uploader.Ingest(ctx, p)
		if err == nil {
			return out, nil
		}
		lastErr = err
		var apiErr *client.APIError
		switch {
		case errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized && apiErr.Code == "machine_revoked":
			return nil, ErrRevoked
		case errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized:
			return nil, ErrBadToken
		case errors.As(err, &apiErr) && apiErr.Status == http.StatusTooManyRequests:
			wait := apiErr.RetryAfter
			if wait > maxRetryAfter {
				return nil, fmt.Errorf("the dashboard is busy and asked to wait %s; the next scheduled sync tries again", wait.Round(time.Second))
			}
			if wait <= 0 {
				wait = 2 * time.Second
			}
			if err := s.Sleep(ctx, wait); err != nil {
				return nil, err
			}
			continue
		case errors.As(err, &apiErr) && apiErr.Status < 500:
			return nil, fmt.Errorf("the dashboard refused the upload: %w (%v)", err, apiErr.Body)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if i < attempts-1 {
			if err := s.Sleep(ctx, backoff); err != nil {
				return nil, err
			}
			backoff *= 2
		}
	}
	return nil, fmt.Errorf("%w: %v", ErrUnreachable, lastErr)
}

func addDays(date string, n int) string {
	t, _ := time.Parse(time.DateOnly, date)
	return t.AddDate(0, 0, n).Format(time.DateOnly)
}

func daysBetween(from, to string) int {
	a, _ := time.Parse(time.DateOnly, from)
	b, _ := time.Parse(time.DateOnly, to)
	return int(b.Sub(a).Hours()/24) + 1
}

// chunks splits [from, to] into consecutive ranges of at most size days.
func chunks(from, to string, size int) [][2]string {
	var out [][2]string
	for start := from; start <= to; start = addDays(start, size) {
		end := addDays(start, size-1)
		if end > to {
			end = to
		}
		out = append(out, [2]string{start, end})
	}
	return out
}

// lastSuccessDate is the day of the last successful sync in the dashboard's
// zone, or "" if there was none.
func (s *Syncer) lastSuccessDate(loc *time.Location) string {
	if s.State.LastSuccessAt.IsZero() {
		return ""
	}
	return s.State.LastSuccessAt.In(loc).Format(time.DateOnly)
}

// toolStarts returns, for each of sources with usage in [from, to], the
// first day of that usage: the upload replaces the tool's rows from then on
// and keeps the older ones, whose logs are gone. If no tool has usage, every
// tool starts today, so the sync still reaches the dashboard (only rows
// uploaded earlier today could be cleared).
func toolStarts(days []ccusage.Day, sources []string, from, to, today string) map[string]string {
	starts := map[string]string{}
	for _, d := range days { // sorted by date
		if _, seen := starts[d.Source]; !seen && d.Date >= from && d.Date <= to && slices.Contains(sources, d.Source) {
			starts[d.Source] = d.Date
		}
	}
	if len(starts) == 0 {
		for _, src := range sources {
			starts[src] = today
		}
	}
	return starts
}

// segment is a date range uploaded for the same tools.
type segment struct {
	from, to string
	sources  []string
}

// segments splits the upload into ranges of at most 100 days that each
// cover the same tools: every tool from its start on (see toolStarts).
func segments(starts map[string]string, sources []string, to string) []segment {
	var bounds []string
	for _, d := range starts {
		bounds = append(bounds, d)
	}
	slices.Sort(bounds)
	bounds = slices.Compact(bounds)
	var out []segment
	for i, start := range bounds {
		end := to
		if i+1 < len(bounds) {
			end = addDays(bounds[i+1], -1)
		}
		var covered []string
		for _, src := range sources {
			if d, ok := starts[src]; ok && d <= start {
				covered = append(covered, src)
			}
		}
		for _, c := range chunks(start, end, payload.MaxRangeDays) {
			out = append(out, segment{from: c[0], to: c[1], sources: covered})
		}
	}
	return out
}

// foldModels keeps each day within the dashboard's limit of models per day:
// the largest stay, and the rest are added up as one OtherModels entry. It
// returns how many days were folded.
func foldModels(days []ccusage.Day) int {
	folded := 0
	for i, d := range days {
		if len(d.Models) <= payload.MaxModelsPerDay {
			continue
		}
		models := slices.Clone(d.Models)
		slices.SortStableFunc(models, func(a, b ccusage.ModelUsage) int {
			return cmp.Or(cmp.Compare(b.CostUSD, a.CostUSD), cmp.Compare(tokens(b), tokens(a)))
		})
		other := ccusage.ModelUsage{Model: OtherModels}
		var kept []ccusage.ModelUsage
		for j, m := range models {
			if j < payload.MaxModelsPerDay-1 && m.Model != OtherModels {
				kept = append(kept, m)
				continue
			}
			other.InputTokens += m.InputTokens
			other.OutputTokens += m.OutputTokens
			other.CacheCreationTokens += m.CacheCreationTokens
			other.CacheReadTokens += m.CacheReadTokens
			other.CostUSD += m.CostUSD
		}
		kept = append(kept, other)
		slices.SortFunc(kept, func(a, b ccusage.ModelUsage) int { return strings.Compare(a.Model, b.Model) })
		days[i].Models = kept
		folded++
	}
	return folded
}

func tokens(m ccusage.ModelUsage) int64 {
	return m.InputTokens + m.OutputTokens + m.CacheCreationTokens + m.CacheReadTokens
}

func joinWarnings(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}
