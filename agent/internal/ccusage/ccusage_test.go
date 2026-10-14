package ccusage

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	raw := `{"daily":[
	  {"date":"2026-10-14","modelBreakdowns":[
	    {"modelName":"claude-opus-5-5","inputTokens":1,"outputTokens":2,"cacheCreationTokens":3,"cacheReadTokens":4,"cost":0.5},
	    {"modelName":"<synthetic>","inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0},
	    {"modelName":"odd model","inputTokens":1,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":-0.0},
	    {"modelName":"odd_model","inputTokens":2,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0.25}
	  ]},
	  {"date":"2026-10-12","modelBreakdowns":[
	    {"modelName":"claude-haiku-5-5","inputTokens":5,"outputTokens":5,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0.01}
	  ]},
	  {"date":"2026-10-13","modelBreakdowns":[
	    {"modelName":"<synthetic>","inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0}
	  ]}
	],"totals":{}}`
	r, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Days) != 2 || r.Earliest() != "2026-10-12" || r.Latest() != "2026-10-14" {
		t.Fatalf("days: %+v", r.Days)
	}
	day := r.Days[1]
	if len(day.Models) != 2 {
		t.Fatalf("models: %+v", day.Models)
	}
	if m := day.Models[1]; m.Model != "odd_model" || m.InputTokens != 3 || m.CostUSD != 0.25 {
		t.Fatalf("sanitized + merged model: %+v", m)
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	for _, raw := range []string{
		`not json`,
		`{"daily":[{"date":"10/14/2026","modelBreakdowns":[]}]}`,
		`{"daily":[{"date":"2026-02-30","modelBreakdowns":[]}]}`,
		`{"daily":[{"date":"2026-10-14","modelBreakdowns":[{"modelName":"x","inputTokens":-1}]}]}`,
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestSanitizeModel(t *testing.T) {
	cases := map[string]string{
		"claude-opus-5-5": "claude-opus-5-5",
		" spaced name ":   "spaced_name",
		"":                "unknown",
		"naïve":           "na_ve",
	}
	for in, want := range cases {
		if got := SanitizeModel(in); got != want {
			t.Errorf("SanitizeModel(%q) = %q, want %q", in, got, want)
		}
	}
	if got := SanitizeModel(strings.Repeat("a", 300)); len(got) != 200 {
		t.Errorf("long name not truncated: %d", len(got))
	}
}

func TestPinnedChecksumExistsForReleasedPlatforms(t *testing.T) {
	for _, p := range []string{"windows/amd64", "linux/amd64"} {
		if pinned.Platforms[p].SHA256 == "" {
			t.Errorf("no SHA-256 pinned for %s", p)
		}
	}
	if Version() == "" {
		t.Error("no version pinned")
	}
}

// realRunner returns the pinned ccusage fetched by tools/fetchccusage. CI
// sets CCUNIFIED_REQUIRE_CCUSAGE=1 so a missing binary fails instead of skipping.
func realRunner(t *testing.T) *Runner {
	t.Helper()
	path := filepath.Join("bin", runtime.GOOS+"-"+runtime.GOARCH, ExeName())
	if _, err := os.Stat(path); err != nil {
		if os.Getenv("CCUNIFIED_REQUIRE_CCUSAGE") == "1" {
			t.Fatalf("pinned ccusage missing at %s (run: go run ./tools/fetchccusage)", path)
		}
		t.Skipf("pinned ccusage not fetched (go run ./tools/fetchccusage); skipping")
	}
	abs, _ := filepath.Abs(path)
	return &Runner{Path: abs, Verify: true}
}

func envWith(t *testing.T, claudeDir string) []string {
	t.Helper()
	home := t.TempDir()
	return []string{
		"CLAUDE_CONFIG_DIR=" + claudeDir,
		"HOME=" + home,
		"USERPROFILE=" + home,
		"PATH=" + os.Getenv("PATH"),
		"SYSTEMROOT=" + os.Getenv("SYSTEMROOT"),
	}
}

func TestRealCcusageGroupsByTimezoneAndDeduplicates(t *testing.T) {
	r := realRunner(t)
	claude, _ := filepath.Abs(filepath.Join("testdata", "claude"))
	r.Env = envWith(t, claude)
	ctx := context.Background()

	utc, err := r.Daily(ctx, Options{Timezone: "UTC", Offline: true})
	if err != nil {
		t.Fatal(err)
	}
	dates := []string{}
	for _, d := range utc.Days {
		dates = append(dates, d.Date)
	}
	if strings.Join(dates, ",") != "2026-10-10,2026-10-13,2026-10-14" {
		t.Fatalf("UTC dates: %v", dates)
	}
	// The duplicated log line (same message and request id) counts once,
	// and the <synthetic> zero-token entry is dropped.
	oct13 := utc.Days[1]
	if len(oct13.Models) != 1 || oct13.Models[0].InputTokens != 100 || oct13.Models[0].CacheReadTokens != 2000 {
		t.Fatalf("2026-10-13 UTC: %+v", oct13.Models)
	}
	if oct14 := utc.Days[2]; len(oct14.Models) != 1 || oct14.Models[0].Model != "claude-haiku-5-5" {
		t.Fatalf("2026-10-14 UTC: %+v", oct14.Models)
	}

	// In Toronto (UTC-4) the 23:30 and 02:00 UTC requests fall on the same day.
	toronto, err := r.Daily(ctx, Options{Timezone: "America/Toronto", Offline: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(toronto.Days) != 2 || toronto.Days[1].Date != "2026-10-13" || len(toronto.Days[1].Models) != 2 {
		t.Fatalf("Toronto: %+v", toronto.Days)
	}

	since, err := r.Daily(ctx, Options{Timezone: "UTC", Since: "2026-10-13", Offline: true})
	if err != nil {
		t.Fatal(err)
	}
	if since.Earliest() != "2026-10-13" {
		t.Fatalf("since: %+v", since.Days)
	}
}

func TestRealCcusageWithoutClaudeData(t *testing.T) {
	r := realRunner(t)
	r.Env = envWith(t, filepath.Join(t.TempDir(), "missing"))
	rep, err := r.Daily(context.Background(), Options{Timezone: "UTC", Offline: true})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.NoClaudeData || len(rep.Days) != 0 {
		t.Fatalf("got %+v", rep)
	}
}

func TestTamperedCcusageIsRefused(t *testing.T) {
	r := realRunner(t)
	data, err := os.ReadFile(r.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.CheckIntegrity(); err != nil {
		t.Fatalf("pinned binary rejected: %v", err)
	}
	tampered := filepath.Join(t.TempDir(), ExeName())
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(tampered, data, 0o755); err != nil {
		t.Fatal(err)
	}
	bad := &Runner{Path: tampered, Verify: true}
	if _, err := bad.Daily(context.Background(), Options{Timezone: "UTC"}); err == nil ||
		!strings.Contains(err.Error(), "does not match the pinned version") {
		t.Fatalf("tampered binary was run: %v", err)
	}
}

func TestParseAll(t *testing.T) {
	raw := `{"daily":[
	  {"period":"2026-10-13","agent":"all","agents":[
	    {"agent":"claude","modelBreakdowns":[
	      {"modelName":"claude-opus-5-5","inputTokens":1,"outputTokens":2,"cacheCreationTokens":3,"cacheReadTokens":4,"cost":0.5}]},
	    {"agent":"codex","modelBreakdowns":[
	      {"modelName":"gpt-5.5","inputTokens":10,"outputTokens":2,"cacheCreationTokens":0,"cacheReadTokens":20,"cost":0.1},
	      {"modelName":"<synthetic>","inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0}]},
	    {"agent":"New Tool","modelBreakdowns":[
	      {"modelName":"m","inputTokens":1,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0}]}
	  ]},
	  {"period":"2026-10-12","agent":"all","agents":[
	    {"agent":"gemini","modelBreakdowns":[
	      {"modelName":"gemini-3-pro","inputTokens":5,"outputTokens":5,"cacheCreationTokens":0,"cacheReadTokens":0,"cost":0.01}]},
	    {"agent":"codex","modelBreakdowns":[]}
	  ]}
	],"totals":{}}`
	r, err := ParseAll([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, d := range r.Days {
		got = append(got, fmt.Sprintf("%s %s %d", d.Date, d.Source, len(d.Models)))
	}
	if strings.Join(got, ", ") != "2026-10-12 gemini 1, 2026-10-13 claude 1, 2026-10-13 codex 1, 2026-10-13 new-tool 1" {
		t.Fatalf("days: %v", got)
	}
	// Every tool ccusage reads is covered, plus any it reported that we didn't know.
	if len(r.Sources) != len(Tools)+1 || r.Sources[0] != "claude" || r.Sources[len(r.Sources)-1] != "new-tool" {
		t.Fatalf("sources: %v", r.Sources)
	}
	if _, err := ParseAll([]byte(`{"daily":[{"period":"2026-13-01","agents":[{"agent":"codex","modelBreakdowns":[]}]}]}`)); err == nil {
		t.Fatal("accepted a bad date")
	}
}

func TestSanitizeSource(t *testing.T) {
	cases := map[string]string{
		"codex":      "codex",
		"Kilo Code":  "kilo-code",
		"1st":        "t1st",
		"":           "t",
		"pi_agent":   "pi_agent",
		"ünïcode":    "t-n-code",
		"tool.name":  "tool-name",
		"UPPER-case": "upper-case",
	}
	for in, want := range cases {
		if got := SanitizeSource(in); got != want || !sourceRe.MatchString(got) {
			t.Errorf("SanitizeSource(%q) = %q, want %q", in, got, want)
		}
	}
	if got := SanitizeSource(strings.Repeat("a", 40)); len(got) != 32 {
		t.Errorf("long id not truncated: %q", got)
	}
}

// The tool list must be exactly the tools the pinned ccusage reads, with the
// names its help gives them.
func TestToolsMatchPinnedCcusage(t *testing.T) {
	r := realRunner(t)
	out, err := exec.Command(r.Path, "--help").Output()
	if err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`^\s+([a-z][a-z0-9_-]*)\s+Show (.+?) (?:token )?usage commands$`)
	var got []Tool
	for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
		if m := line.FindStringSubmatch(l); m != nil {
			got = append(got, Tool{ID: m[1], Name: m[2]})
		}
	}
	if fmt.Sprint(got) != fmt.Sprint(Tools) {
		t.Fatalf("ccusage %s reads:\n%v\nbut Tools is:\n%v", Version(), got, Tools)
	}
}

func envWithTools(t *testing.T, claudeDir, codexDir string) []string {
	t.Helper()
	return append(envWith(t, claudeDir), "CODEX_HOME="+codexDir)
}

func TestRealCcusageReadsEveryTool(t *testing.T) {
	r := realRunner(t)
	claude, _ := filepath.Abs(filepath.Join("testdata", "claude"))
	codex, _ := filepath.Abs(filepath.Join("testdata", "codex"))
	r.Env = envWithTools(t, claude, codex)

	rep, err := r.Daily(context.Background(), Options{Timezone: "UTC", Offline: true, AllTools: true})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Warning != "" || len(rep.Sources) < len(Tools) {
		t.Fatalf("report: %+v", rep)
	}
	got := map[string]ModelUsage{}
	for _, d := range rep.Days {
		if d.Source != "claude" && d.Source != "codex" {
			continue // a tool this computer really uses outside the test's folders
		}
		for _, m := range d.Models {
			got[d.Date+" "+d.Source+" "+m.Model] = m
		}
	}
	// Codex counts cached input separately: 30,000 input tokens of which
	// 20,000 were cache reads.
	if m := got["2026-10-13 codex gpt-5.5"]; m.InputTokens != 10000 || m.CacheReadTokens != 20000 || m.OutputTokens != 2100 || m.CostUSD <= 0 {
		t.Fatalf("codex: %+v (all: %v)", m, got)
	}
	// Claude Code's numbers are the same as in its own report.
	alone, err := r.Daily(context.Background(), Options{Timezone: "UTC", Offline: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range alone.Days {
		for _, m := range d.Models {
			if got[d.Date+" claude "+m.Model] != m {
				t.Errorf("%s %s: all tools %+v, Claude Code alone %+v", d.Date, m.Model, got[d.Date+" claude "+m.Model], m)
			}
		}
	}
}

func TestRealCcusageFallsBackToClaudeCode(t *testing.T) {
	r := realRunner(t)
	// ccusage refuses to read anything when CLAUDE_CONFIG_DIR points nowhere.
	r.Env = envWith(t, filepath.Join(t.TempDir(), "missing"))
	rep, err := r.Daily(context.Background(), Options{Timezone: "UTC", Offline: true, AllTools: true})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(rep.Sources) != "[claude]" || !rep.NoClaudeData || !strings.Contains(rep.Warning, "No valid Claude data directories") {
		t.Fatalf("got %+v", rep)
	}
}
