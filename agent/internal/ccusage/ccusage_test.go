package ccusage

import (
	"context"
	"os"
	"path/filepath"
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
