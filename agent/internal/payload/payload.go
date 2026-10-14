// Package payload defines the upload format sent to POST /agent/ingest.
//
// The format's source of truth is worker/src/ingest/schema.ts; it is published
// as schema/ingest.schema.json. The tests in this package check these types
// against that JSON Schema and the shared examples in schema/examples/.
package payload

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"time"
)

// SchemaVersion is the payload format version this agent produces.
const SchemaVersion = 1

// Limits mirrored from the Worker. Larger backfills are split into several uploads.
const (
	MaxRangeDays     = 100
	MaxDaysPerUpload = 100
	MaxModelsPerDay  = 50
	maxTokens        = 1_000_000_000_000_000
	maxCostUSD       = 1_000_000_000
)

// SourceClaude identifies usage read from Claude Code's logs.
const SourceClaude = "claude"

// Payload is one upload from a machine.
type Payload struct {
	SchemaVersion int    `json:"schema_version"`
	Agent         Agent  `json:"agent"`
	Timezone      string `json:"timezone"`
	Range         Range  `json:"range"`
	Days          []Day  `json:"days"`
}

// Range is the inclusive span of dates an upload covers. The server replaces
// all of the machine's rows in this span, so days with no usage are cleared.
type Range struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Agent describes the uploading program and machine.
type Agent struct {
	Version             string `json:"version"`
	OS                  string `json:"os"`
	Arch                string `json:"arch"`
	CcusageVersion      string `json:"ccusage_version"`
	SyncIntervalMinutes int    `json:"sync_interval_minutes"`
}

// Day holds one day's usage for one source, split by model.
type Day struct {
	Date   string  `json:"date"`
	Source string  `json:"source"`
	Models []Model `json:"models"`
}

// Model holds token counts and estimated cost for one model on one day.
type Model struct {
	Model               string  `json:"model"`
	InputTokens         int64   `json:"input_tokens"`
	OutputTokens        int64   `json:"output_tokens"`
	CacheCreationTokens int64   `json:"cache_creation_tokens"`
	CacheReadTokens     int64   `json:"cache_read_tokens"`
	CostUSD             float64 `json:"cost_usd"`
}

var (
	versionRe = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,64}$`)
	modelRe   = regexp.MustCompile(`^[\x21-\x7e]{1,200}$`)
	dateRe    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// Validate applies the same rules as the Worker, so a bad payload is caught
// before it is sent.
func (p *Payload) Validate() error {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if p.SchemaVersion != SchemaVersion {
		fail("schema_version: got %d, want %d", p.SchemaVersion, SchemaVersion)
	}
	if !versionRe.MatchString(p.Agent.Version) {
		fail("agent.version: invalid %q", p.Agent.Version)
	}
	if !versionRe.MatchString(p.Agent.CcusageVersion) {
		fail("agent.ccusage_version: invalid %q", p.Agent.CcusageVersion)
	}
	switch p.Agent.OS {
	case "windows", "linux", "darwin":
	default:
		fail("agent.os: unsupported %q", p.Agent.OS)
	}
	switch p.Agent.Arch {
	case "amd64", "arm64":
	default:
		fail("agent.arch: unsupported %q", p.Agent.Arch)
	}
	switch p.Agent.SyncIntervalMinutes {
	case 15, 30, 60:
	default:
		fail("agent.sync_interval_minutes: must be 15, 30 or 60, got %d", p.Agent.SyncIntervalMinutes)
	}
	if p.Timezone == "" || len(p.Timezone) > 64 {
		fail("timezone: must be 1-64 characters")
	}
	from, fromErr := parseDate(p.Range.From)
	to, toErr := parseDate(p.Range.To)
	switch {
	case fromErr != nil || toErr != nil:
		fail("range: invalid dates %q..%q", p.Range.From, p.Range.To)
	case to.Before(from):
		fail("range: from %s is after to %s", p.Range.From, p.Range.To)
	case int(to.Sub(from).Hours()/24)+1 > MaxRangeDays:
		fail("range: covers more than %d days", MaxRangeDays)
	}
	if p.Days == nil {
		fail("days: must be a list, not null")
	}
	if len(p.Days) > MaxDaysPerUpload {
		fail("days: %d entries, at most %d per upload", len(p.Days), MaxDaysPerUpload)
	}

	seenDays := make(map[string]bool, len(p.Days))
	for i, d := range p.Days {
		if _, err := parseDate(d.Date); err != nil {
			fail("days[%d].date: invalid %q", i, d.Date)
		} else if fromErr == nil && toErr == nil && (d.Date < p.Range.From || d.Date > p.Range.To) {
			fail("days[%d].date: %s is outside range %s..%s", i, d.Date, p.Range.From, p.Range.To)
		}
		if d.Source != SourceClaude {
			fail("days[%d].source: unsupported %q", i, d.Source)
		}
		key := d.Source + "/" + d.Date
		if seenDays[key] {
			fail("days[%d]: duplicate %s", i, key)
		}
		seenDays[key] = true

		if d.Models == nil {
			fail("days[%d].models: must be a list, not null", i)
		}
		if len(d.Models) > MaxModelsPerDay {
			fail("days[%d].models: %d entries, at most %d", i, len(d.Models), MaxModelsPerDay)
		}
		seenModels := make(map[string]bool, len(d.Models))
		for j, m := range d.Models {
			at := fmt.Sprintf("days[%d].models[%d]", i, j)
			if !modelRe.MatchString(m.Model) {
				fail("%s.model: invalid %q", at, m.Model)
			}
			if seenModels[m.Model] {
				fail("%s.model: duplicate %q", at, m.Model)
			}
			seenModels[m.Model] = true
			for name, v := range map[string]int64{
				"input_tokens":          m.InputTokens,
				"output_tokens":         m.OutputTokens,
				"cache_creation_tokens": m.CacheCreationTokens,
				"cache_read_tokens":     m.CacheReadTokens,
			} {
				if v < 0 || v > maxTokens {
					fail("%s.%s: out of range (%d)", at, name, v)
				}
			}
			if math.IsNaN(m.CostUSD) || m.CostUSD < 0 || m.CostUSD > maxCostUSD {
				fail("%s.cost_usd: out of range (%v)", at, m.CostUSD)
			}
		}
	}
	return errors.Join(errs...)
}

// parseDate accepts exactly YYYY-MM-DD with a real calendar date.
func parseDate(s string) (time.Time, error) {
	if !dateRe.MatchString(s) {
		return time.Time{}, fmt.Errorf("not YYYY-MM-DD: %q", s)
	}
	return time.Parse(time.DateOnly, s)
}
