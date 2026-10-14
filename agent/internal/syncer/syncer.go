// Package syncer reads this machine's usage with ccusage and uploads it to
// the dashboard.
//
// The first sync (and the first after the dashboard's time zone changes)
// uploads the whole history still on disk, in chunks of at most 100 days.
// Later syncs re-send the last 7 days: the dashboard replaces each uploaded
// range, so sending a day twice never counts it twice, and missed syncs are
// filled in by the next one.
package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime"
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

// Usage is where the daily report comes from (ccusage, or a fake in tests).
type Usage interface {
	Daily(ctx context.Context, opts ccusage.Options) (*ccusage.Report, error)
}

// Uploader sends payloads (the dashboard client, or a fake in tests).
type Uploader interface {
	Ingest(ctx context.Context, p *payload.Payload) (*client.IngestResult, error)
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
	NoClaudeData  bool
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
	s.State.LastAttemptAt = s.Now()
	res, err := s.run(ctx, false)
	if err != nil {
		s.State.LastError = err.Error()
		return res, err
	}
	s.State.LastError = ""
	s.State.LastSuccessAt = s.Now()
	s.State.LastChanged = res.ChangedRows
	s.State.LastDays = res.DaysWithUsage
	s.State.NoClaudeData = res.NoClaudeData
	if res.LatestVersion != "" {
		s.State.LatestVersion = res.LatestVersion
	}
	return res, nil
}

func (s *Syncer) run(ctx context.Context, retriedTimezone bool) (*Result, error) {
	tz := s.Config.Timezone
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("invalid time zone %q: %w", tz, err)
	}
	today := s.Now().In(loc).Format(time.DateOnly)
	full := s.Full || s.State.BackfillTimezone != tz

	opts := ccusage.Options{Timezone: tz}
	from := addDays(today, -(RecentDays - 1))
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

	res := &Result{Full: full, From: from, To: to, NoClaudeData: report.NoClaudeData}
	for _, d := range report.Days {
		if d.Date >= from && d.Date <= to {
			res.DaysWithUsage++
		}
	}

	for _, chunk := range chunks(from, to, payload.MaxRangeDays) {
		payloads, err := s.build(report, chunk[0], chunk[1])
		if err != nil {
			return res, err
		}
		for _, p := range payloads {
			out, err := s.upload(ctx, p)
			var apiErr *client.APIError
			if errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict && apiErr.Code == "timezone_mismatch" {
				newTz := apiErr.Field("timezone")
				if retriedTimezone || newTz == "" || newTz == tz {
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
				return s.run(ctx, true)
			}
			if err != nil {
				return res, err
			}
			res.Uploads++
			res.ChangedRows += out.ChangedRows
			if out.LatestVersion != nil {
				res.LatestVersion = *out.LatestVersion
			}
		}
	}
	if full {
		s.State.BackfillTimezone = tz
	}
	return res, nil
}

// build makes the payload(s) for one date range, halving the range until
// each payload is small enough to upload.
func (s *Syncer) build(report *ccusage.Report, from, to string) ([]*payload.Payload, error) {
	p := &payload.Payload{
		SchemaVersion: payload.SchemaVersion,
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
	for _, d := range report.Days {
		if d.Date < from || d.Date > to {
			continue
		}
		day := payload.Day{Date: d.Date, Source: payload.SourceClaude, Models: []payload.Model{}}
		for _, m := range d.Models {
			if len(day.Models) == payload.MaxModelsPerDay {
				break // more models in one day than the dashboard accepts; keep the first 50
			}
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
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("internal error building the upload: %w", err)
	}
	data, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	if len(data) <= maxPayloadBytes || from == to {
		if len(data) > maxPayloadBytes {
			return nil, fmt.Errorf("usage for %s is too large to upload (%d bytes)", from, len(data))
		}
		return []*payload.Payload{p}, nil
	}
	mid := addDays(from, daysBetween(from, to)/2-1)
	left, err := s.build(report, from, mid)
	if err != nil {
		return nil, err
	}
	right, err := s.build(report, addDays(mid, 1), to)
	if err != nil {
		return nil, err
	}
	return append(left, right...), nil
}

// upload sends one payload, waiting and retrying on rate limits and on
// network or server trouble (1, 2, 4, 8 then 16 seconds apart).
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
			if wait <= 0 || wait > 30*time.Second {
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
