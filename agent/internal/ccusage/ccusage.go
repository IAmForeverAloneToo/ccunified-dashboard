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
}

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

// Day is one calendar day (in the requested time zone).
type Day struct {
	Date   string
	Models []ModelUsage
}

// Report is ccusage's daily report, sorted by date.
type Report struct {
	Days []Day
	// NoClaudeData is set when this machine has no Claude Code logs at all.
	NoClaudeData bool
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

type rawReport struct {
	Daily []struct {
		Date            string `json:"date"`
		ModelBreakdowns []struct {
			ModelName           string  `json:"modelName"`
			InputTokens         int64   `json:"inputTokens"`
			OutputTokens        int64   `json:"outputTokens"`
			CacheCreationTokens int64   `json:"cacheCreationTokens"`
			CacheReadTokens     int64   `json:"cacheReadTokens"`
			Cost                float64 `json:"cost"`
		} `json:"modelBreakdowns"`
	} `json:"daily"`
}

var (
	dateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	badModelRe = regexp.MustCompile(`[^\x21-\x7e]`)
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

// Parse reads ccusage's `claude daily --json` output. Models with no tokens
// at all (such as Claude Code's internal "<synthetic>" entries) are dropped,
// and entries that sanitize to the same name are merged.
func Parse(data []byte) (*Report, error) {
	var raw rawReport
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unexpected ccusage output: %w", err)
	}
	byDate := map[string]map[string]*ModelUsage{}
	for _, d := range raw.Daily {
		if !dateRe.MatchString(d.Date) {
			return nil, fmt.Errorf("unexpected date %q in ccusage output", d.Date)
		}
		if _, err := time.Parse(time.DateOnly, d.Date); err != nil {
			return nil, fmt.Errorf("unexpected date %q in ccusage output", d.Date)
		}
		models := byDate[d.Date]
		if models == nil {
			models = map[string]*ModelUsage{}
			byDate[d.Date] = models
		}
		for _, m := range d.ModelBreakdowns {
			if m.InputTokens < 0 || m.OutputTokens < 0 || m.CacheCreationTokens < 0 || m.CacheReadTokens < 0 {
				return nil, fmt.Errorf("negative token count for %s on %s", m.ModelName, d.Date)
			}
			if m.InputTokens+m.OutputTokens+m.CacheCreationTokens+m.CacheReadTokens == 0 {
				continue
			}
			name := SanitizeModel(m.ModelName)
			u := models[name]
			if u == nil {
				u = &ModelUsage{Model: name}
				models[name] = u
			}
			u.InputTokens += m.InputTokens
			u.OutputTokens += m.OutputTokens
			u.CacheCreationTokens += m.CacheCreationTokens
			u.CacheReadTokens += m.CacheReadTokens
			if m.Cost > 0 {
				u.CostUSD += m.Cost
			}
		}
	}
	report := &Report{}
	for date, models := range byDate {
		if len(models) == 0 {
			continue
		}
		day := Day{Date: date}
		for _, u := range models {
			day.Models = append(day.Models, *u)
		}
		sort.Slice(day.Models, func(i, j int) bool { return day.Models[i].Model < day.Models[j].Model })
		report.Days = append(report.Days, day)
	}
	sort.Slice(report.Days, func(i, j int) bool { return report.Days[i].Date < report.Days[j].Date })
	return report, nil
}

// Options select what the daily report covers.
type Options struct {
	// Timezone groups usage into days (IANA name).
	Timezone string
	// Since limits the report to this date and later (YYYY-MM-DD); empty means all history.
	Since string
	// Offline uses ccusage's built-in price list instead of fetching the latest prices.
	Offline bool
}

const runTimeout = 5 * time.Minute

// Daily runs `ccusage claude daily --json` and parses the result. If
// fetching current prices fails, it retries once with the built-in prices.
func (r *Runner) Daily(ctx context.Context, opts Options) (*Report, error) {
	opts.Offline = opts.Offline || r.Offline
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
	args := []string{"claude", "daily", "--json", "--timezone", opts.Timezone}
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
		if strings.Contains(msg, "No valid Claude data directories found") {
			return &Report{NoClaudeData: true}, nil
		}
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if len(msg) > 500 {
			msg = msg[:500] + "…"
		}
		return nil, fmt.Errorf("ccusage failed: %w: %s", err, msg)
	}
	return Parse(stdout.Bytes())
}

// ReportedVersion runs `ccusage --version` (for diagnostics).
func (r *Runner) ReportedVersion(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Path, "--version")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(strings.TrimSpace(string(out)), "ccusage "), nil
}
