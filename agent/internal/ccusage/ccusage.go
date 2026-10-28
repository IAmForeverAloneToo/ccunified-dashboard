// Package ccusage runs the pinned ccusage program and reads its daily report.
//
// ccusage ships next to the ccunified program. Before every run its SHA-256
// is checked against pinned.json, so only the exact pinned build is ever
// executed.
package ccusage

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

//go:embed pinned.json
var pinnedJSON []byte

type pinnedFile struct {
	Version   string `json:"version"`
	Platforms map[string]struct {
		SHA256 string `json:"sha256"`
	} `json:"platforms"`
}

var pinned = func() pinnedFile {
	var p pinnedFile
	if err := json.Unmarshal(pinnedJSON, &p); err != nil {
		panic("ccusage: bad pinned.json: " + err.Error())
	}
	return p
}()

// Version is the pinned ccusage version.
func Version() string { return pinned.Version }

// ExpectedSHA256 returns the pinned checksum of ccusage for this platform.
func ExpectedSHA256() (string, bool) {
	p, ok := pinned.Platforms[runtime.GOOS+"/"+runtime.GOARCH]
	return p.SHA256, ok && p.SHA256 != ""
}

// ExeName is the file name of the ccusage program on this platform.
func ExeName() string {
	if runtime.GOOS == "windows" {
		return "ccusage.exe"
	}
	return "ccusage"
}

// Runner runs one ccusage program.
type Runner struct {
	Path string
	// Verify checks the program against the pinned SHA-256 before each run.
	Verify bool
	// Env, if set, replaces the environment (tests).
	Env []string
	// Offline always uses ccusage's built-in price list.
	Offline bool
	// AsUser runs ccusage as another account (a system-wide install reading
	// that account's usage; Linux only), so files it creates belong to it.
	AsUser *Account
}

// Account is a user account's ids.
type Account struct{ UID, GID int }

// Locate finds ccusage next to the running program. CCUNIFIED_CCUSAGE
// overrides the path (development and tests);
// CCUNIFIED_CCUSAGE_UNVERIFIED=1 additionally skips the checksum check.
func Locate() (*Runner, error) {
	if p := os.Getenv("CCUNIFIED_CCUSAGE"); p != "" {
		return &Runner{Path: p, Verify: os.Getenv("CCUNIFIED_CCUSAGE_UNVERIFIED") != "1"}, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	path := filepath.Join(filepath.Dir(exe), ExeName())
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("ccusage was not found next to ccunified (%s); reinstall ccunified", path)
	}
	return &Runner{Path: path, Verify: true}, nil
}

// ErrChecksum means the ccusage program is not the pinned build.
var ErrChecksum = errors.New("ccusage does not match the pinned version")

// CheckIntegrity verifies the program against the pinned SHA-256.
func (r *Runner) CheckIntegrity() error {
	want, ok := ExpectedSHA256()
	if !ok {
		return fmt.Errorf("%w: no checksum pinned for %s/%s", ErrChecksum, runtime.GOOS, runtime.GOARCH)
	}
	f, err := os.Open(r.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("%w (%s): expected SHA-256 %s, found %s; reinstall ccunified", ErrChecksum, r.Path, want, got)
	}
	return nil
}

// ModelUsage is one model's usage on one day.
type ModelUsage struct {
	Model               string
	InputTokens         int64
	OutputTokens        int64
	CacheCreationTokens int64
	CacheReadTokens     int64
	CostUSD             float64
}

// Day is one tool's usage on one calendar day (in the requested time zone).
type Day struct {
	Date string
	// Source is the tool, such as "claude" or "codex" (see Tools).
	Source string
	Models []ModelUsage
}

// Report is ccusage's daily report, sorted by date, then tool.
type Report struct {
	Days []Day
	// Sources are the tools the report covers: every tool ccusage looked
	// for, whether or not it found any usage.
	Sources []string
	// NoClaudeData is set when a Claude Code-only report found no Claude
	// Code logs at all.
	NoClaudeData bool
	// Warning says why a report covers only Claude Code although every tool
	// was asked for.
	Warning string
}

// Earliest returns the first date with usage, or "" if there is none.
func (r *Report) Earliest() string {
	if len(r.Days) == 0 {
		return ""
	}
	return r.Days[0].Date
}

// Latest returns the last date with usage, or "" if there is none.
func (r *Report) Latest() string {
	if len(r.Days) == 0 {
		return ""
	}
	return r.Days[len(r.Days)-1].Date
}

type rawModel struct {
	ModelName           string  `json:"modelName"`
	InputTokens         int64   `json:"inputTokens"`
	OutputTokens        int64   `json:"outputTokens"`
	CacheCreationTokens int64   `json:"cacheCreationTokens"`
	CacheReadTokens     int64   `json:"cacheReadTokens"`
	Cost                float64 `json:"cost"`
}

// rawClaude is `ccusage claude daily --json`.
type rawClaude struct {
	Daily []struct {
		Date            string     `json:"date"`
		ModelBreakdowns []rawModel `json:"modelBreakdowns"`
	} `json:"daily"`
}

// rawAll is `ccusage daily --json --by-agent`: every tool, one row per day.
type rawAll struct {
	Daily []struct {
		Period string `json:"period"`
		Agents []struct {
			Agent           string     `json:"agent"`
			ModelBreakdowns []rawModel `json:"modelBreakdowns"`
		} `json:"agents"`
	} `json:"daily"`
}

var (
	dateRe      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	badModelRe  = regexp.MustCompile(`[^\x21-\x7e]`)
	sourceRe    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	badSourceRe = regexp.MustCompile(`[^a-z0-9_-]`)
)

// SanitizeModel turns a model name into the upload format's allowed
// characters (printable ASCII without spaces, at most 200).
func SanitizeModel(name string) string {
	name = badModelRe.ReplaceAllString(strings.TrimSpace(name), "_")
	if name == "" {
		name = "unknown"
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}

// SanitizeSource turns a tool name into the upload format's tool ids
// (lowercase letters, digits, '-' and '_', starting with a letter, at most 32).
func SanitizeSource(name string) string {
	name = badSourceRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	if !sourceRe.MatchString(name) {
		name = "t" + name
	}
	if len(name) > 32 {
		name = name[:32]
	}
	return name
}

// collector merges ccusage's rows into a Report.
type collector map[[2]string]map[string]*ModelUsage // (date, source) -> model -> usage

func (c collector) add(date, source string, models []rawModel) error {
	if !dateRe.MatchString(date) {
		return fmt.Errorf("unexpected date %q in ccusage output", date)
	}
	if _, err := time.Parse(time.DateOnly, date); err != nil {
		return fmt.Errorf("unexpected date %q in ccusage output", date)
	}
	key := [2]string{date, source}
	day := c[key]
	if day == nil {
		day = map[string]*ModelUsage{}
		c[key] = day
	}
	for _, m := range models {
		if m.InputTokens < 0 || m.OutputTokens < 0 || m.CacheCreationTokens < 0 || m.CacheReadTokens < 0 {
			return fmt.Errorf("negative token count for %s on %s", m.ModelName, date)
		}
		if m.InputTokens+m.OutputTokens+m.CacheCreationTokens+m.CacheReadTokens == 0 {
			continue
		}
		name := SanitizeModel(m.ModelName)
		u := day[name]
		if u == nil {
			u = &ModelUsage{Model: name}
			day[name] = u
		}
		u.InputTokens += m.InputTokens
		u.OutputTokens += m.OutputTokens
		u.CacheCreationTokens += m.CacheCreationTokens
		u.CacheReadTokens += m.CacheReadTokens
		if m.Cost > 0 {
			u.CostUSD += m.Cost
		}
	}
	return nil
}

func (c collector) report(sources []string) *Report {
	report := &Report{Sources: sources}
	for key, models := range c {
		if len(models) == 0 {
			continue
		}
		day := Day{Date: key[0], Source: key[1]}
		for _, u := range models {
			day.Models = append(day.Models, *u)
		}
		sort.Slice(day.Models, func(i, j int) bool { return day.Models[i].Model < day.Models[j].Model })
		report.Days = append(report.Days, day)
	}
	sort.Slice(report.Days, func(i, j int) bool {
		a, b := report.Days[i], report.Days[j]
		return a.Date < b.Date || (a.Date == b.Date && a.Source < b.Source)
	})
	return report
}

// Parse reads ccusage's `claude daily --json` output (Claude Code only).
// Models with no tokens at all (such as Claude Code's internal "<synthetic>"
// entries) are dropped, and entries that sanitize to the same name are merged.
func Parse(data []byte) (*Report, error) {
	var raw rawClaude
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unexpected ccusage output: %w", err)
	}
	c := collector{}
	for _, d := range raw.Daily {
		if err := c.add(d.Date, "claude", d.ModelBreakdowns); err != nil {
			return nil, err
		}
	}
	return c.report([]string{"claude"}), nil
}

// ParseAll reads ccusage's `daily --json --by-agent` output, which covers
// every tool in Tools. Models are cleaned up as in Parse.
func ParseAll(data []byte) (*Report, error) {
	var raw rawAll
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unexpected ccusage output: %w", err)
	}
	c := collector{}
	sources := make([]string, 0, len(Tools))
	seen := map[string]bool{}
	for _, t := range Tools {
		sources = append(sources, t.ID)
		seen[t.ID] = true
	}
	for _, d := range raw.Daily {
		for _, a := range d.Agents {
			source := SanitizeSource(a.Agent)
			if !seen[source] {
				sources = append(sources, source)
				seen[source] = true
			}
			if err := c.add(d.Period, source, a.ModelBreakdowns); err != nil {
				return nil, err
			}
		}
	}
	return c.report(sources), nil
}

// Options select what the daily report covers.
type Options struct {
	// Timezone groups usage into days (IANA name).
	Timezone string
	// Since limits the report to this date and later (YYYY-MM-DD); empty means all history.
	Since string
	// Offline uses ccusage's built-in price list instead of fetching the latest prices.
	Offline bool
	// AllTools reads every tool in Tools; otherwise only Claude Code.
	AllTools bool
}

const runTimeout = 5 * time.Minute

// Daily runs ccusage's daily report and parses the result. If fetching
// current prices fails, it retries once with the built-in prices. If reading
// every tool fails, it falls back to Claude Code alone and says why in the
// report's Warning.
func (r *Runner) Daily(ctx context.Context, opts Options) (*Report, error) {
	opts.Offline = opts.Offline || r.Offline
	report, err := r.dailyWithFallbackPrices(ctx, opts)
	if err != nil && opts.AllTools && !errors.Is(err, ErrChecksum) && ctx.Err() == nil {
		opts.AllTools = false
		if claude, err2 := r.dailyWithFallbackPrices(ctx, opts); err2 == nil {
			claude.Warning = "only Claude Code's usage could be read: " + err.Error()
			return claude, nil
		}
	}
	return report, err
}

func (r *Runner) dailyWithFallbackPrices(ctx context.Context, opts Options) (*Report, error) {
	report, err := r.daily(ctx, opts)
	if err != nil && !opts.Offline && !errors.Is(err, ErrChecksum) && ctx.Err() == nil {
		opts.Offline = true
		if again, err2 := r.daily(ctx, opts); err2 == nil {
			return again, nil
		}
	}
	return report, err
}

func (r *Runner) daily(ctx context.Context, opts Options) (*Report, error) {
	if r.Verify {
		if err := r.CheckIntegrity(); err != nil {
			return nil, err
		}
	}
	args := []string{"claude", "daily", "--json"}
	if opts.AllTools {
		args = []string{"daily", "--json", "--by-agent"}
	}
	args = append(args, "--timezone", opts.Timezone)
	if opts.Since != "" {
		args = append(args, "--since", strings.ReplaceAll(opts.Since, "-", ""))
	}
	if opts.Offline {
		args = append(args, "--offline")
	}
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Path, args...)
	hideWindow(cmd)
	runAs(cmd, r.AsUser)
	env := r.Env
	if env == nil {
		env = os.Environ()
	}
	cmd.Env = append(env, "NO_COLOR=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if !opts.AllTools && strings.Contains(msg, "No valid Claude data directories found") {
			return &Report{Sources: []string{"claude"}, NoClaudeData: true}, nil
		}
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if len(msg) > 500 {
			msg = msg[:500] + "…"
		}
		return nil, fmt.Errorf("ccusage failed: %w: %s", err, msg)
	}
	if opts.AllTools {
		return ParseAll(stdout.Bytes())
	}
	return Parse(stdout.Bytes())
}

// ReportedVersion runs `ccusage --version` (for diagnostics).
func (r *Runner) ReportedVersion(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Path, "--version")
	hideWindow(cmd)
	runAs(cmd, r.AsUser)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(strings.TrimSpace(string(out)), "ccusage "), nil
}
