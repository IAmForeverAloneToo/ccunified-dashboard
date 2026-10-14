package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
)

// fakeDashboard accepts uploads that pass the published JSON Schema.
type fakeDashboard struct {
	t        *testing.T
	schema   *jsonschema.Schema
	timezone string
	token    string
	mu       sync.Mutex
	uploads  []payload.Payload
}

func (d *fakeDashboard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/agent/ingest" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("authorization") != "Bearer "+d.token {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"error":"invalid_token"}`)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var generic any
	if err := json.Unmarshal(body, &generic); err != nil {
		d.t.Errorf("upload is not JSON: %v", err)
	}
	if err := d.schema.Validate(generic); err != nil {
		d.t.Errorf("upload fails the JSON Schema: %v\n%s", err, body)
	}
	var p payload.Payload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		d.t.Errorf("decode: %v", err)
	}
	if p.Timezone != d.timezone {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "timezone_mismatch", "timezone": d.timezone})
		return
	}
	d.mu.Lock()
	d.uploads = append(d.uploads, p)
	d.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "changed_rows": len(p.Days), "timezone": d.timezone, "server_version": "9.9.9", "latest_version": "9.9.9",
	})
}

func setup(t *testing.T) (*fakeDashboard, *Env, *bytes.Buffer) {
	t.Helper()
	bin, _ := filepath.Abs(filepath.Join("..", "ccusage", "bin", runtime.GOOS+"-"+runtime.GOARCH, ccusage.ExeName()))
	if _, err := os.Stat(bin); err != nil {
		if os.Getenv("CCUNIFIED_REQUIRE_CCUSAGE") == "1" {
			t.Fatalf("pinned ccusage missing at %s", bin)
		}
		t.Skip("pinned ccusage not fetched (go run ./tools/fetchccusage)")
	}
	claude, _ := filepath.Abs(filepath.Join("..", "ccusage", "testdata", "claude"))
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	t.Setenv("CCUNIFIED_CCUSAGE", bin)
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	t.Setenv("CCUNIFIED_CCUSAGE_OFFLINE", "1")

	c := jsonschema.NewCompiler()
	schema, err := c.Compile(filepath.Join("..", "..", "..", "schema", "ingest.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	dash := &fakeDashboard{t: t, schema: schema, timezone: "UTC", token: "ccu_m_" + strings.Repeat("x", 43)}
	srv := httptest.NewServer(dash)
	t.Cleanup(srv.Close)
	cfg := &config.Config{
		DashboardURL: srv.URL, MachineID: "m1", MachineName: "Test PC",
		Token: dash.token, Timezone: "UTC", SyncIntervalMinutes: 30,
	}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	return dash, &Env{Stdin: strings.NewReader(""), Stdout: out, Stderr: out}, out
}

func TestSyncUploadsRealUsage(t *testing.T) {
	dash, env, out := setup(t)

	if code := Main([]string{"sync"}, env); code != 0 {
		t.Fatalf("sync exit %d: %s", code, out)
	}
	if !strings.Contains(out.String(), "full history (2026-10-10 to") {
		t.Fatalf("output: %s", out)
	}
	// The whole history, from the first day with usage to today, contiguously.
	today := time.Now().UTC().Format(time.DateOnly)
	want := "2026-10-10"
	days := map[string]payload.Day{}
	for _, u := range dash.uploads {
		if u.Range.From != want {
			t.Fatalf("gap before %s (want %s)", u.Range.From, want)
		}
		next, _ := time.Parse(time.DateOnly, u.Range.To)
		want = next.AddDate(0, 0, 1).Format(time.DateOnly)
		for _, d := range u.Days {
			days[d.Date] = d
		}
	}
	if last := dash.uploads[len(dash.uploads)-1].Range.To; last < today {
		t.Fatalf("history ends %s, before today %s", last, today)
	}
	if len(days) != 3 {
		t.Fatalf("days with usage: %v", days)
	}
	if d := days["2026-10-13"]; len(d.Models) != 1 || d.Models[0].InputTokens != 100 || d.Models[0].CostUSD <= 0 {
		t.Fatalf("2026-10-13: %+v", d)
	}
	if u := dash.uploads[0]; u.Agent.OS != runtime.GOOS || u.Agent.CcusageVersion != ccusage.Version() || u.Agent.SyncIntervalMinutes != 30 {
		t.Fatalf("agent info: %+v", u.Agent)
	}

	// The next sync sends only the last 7 days.
	dash.uploads = nil
	out.Reset()
	if code := Main([]string{"sync"}, env); code != 0 {
		t.Fatalf("second sync exit %d: %s", code, out)
	}
	if len(dash.uploads) != 1 || dash.uploads[0].Range.To != today {
		t.Fatalf("second sync uploads: %+v", dash.uploads)
	}
	if !strings.Contains(out.String(), "the last 7 days") {
		t.Fatalf("output: %s", out)
	}

	out.Reset()
	if code := Main([]string{"status"}, env); code != 0 {
		t.Fatalf("status exit %d", code)
	}
	for _, s := range []string{"Test PC", "Last upload:  just now", "ccusage:", ", ok"} {
		if !strings.Contains(out.String(), s) {
			t.Errorf("status lacks %q:\n%s", s, out)
		}
	}
}

func TestSyncFollowsTheDashboardsTimezone(t *testing.T) {
	dash, env, out := setup(t)
	dash.timezone = "America/Toronto"
	if code := Main([]string{"sync"}, env); code != 0 {
		t.Fatalf("sync exit %d: %s", code, out)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Timezone != "America/Toronto" {
		t.Fatalf("time zone not saved: %s", cfg.Timezone)
	}
	// In Toronto the 23:30 and 02:00 UTC requests share 2026-10-13.
	for _, u := range dash.uploads {
		for _, d := range u.Days {
			if d.Date == "2026-10-13" && len(d.Models) != 2 {
				t.Fatalf("2026-10-13 in Toronto: %+v", d.Models)
			}
			if d.Date == "2026-10-14" {
				t.Fatalf("no usage should fall on 2026-10-14 in Toronto")
			}
		}
	}
}

func TestSyncWithoutSetupExplainsWhatToDo(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	out := &bytes.Buffer{}
	code := Main([]string{"sync"}, &Env{Stdout: out, Stderr: out})
	if code != 1 || !strings.Contains(out.String(), "run: ccunified setup") {
		t.Fatalf("exit %d: %s", code, out)
	}
}

func TestConfigSetInterval(t *testing.T) {
	dash, env, out := setup(t)
	if code := Main([]string{"config", "set", "interval", "45"}, env); code != 2 {
		t.Fatalf("invalid interval accepted: %s", out)
	}
	if code := Main([]string{"config", "set", "interval", "15"}, env); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	Main([]string{"sync"}, env)
	if got := dash.uploads[0].Agent.SyncIntervalMinutes; got != 15 {
		t.Fatalf("interval sent: %d", got)
	}
}

func TestOnlyOneSyncAtATime(t *testing.T) {
	_, env, out := setup(t)
	unlock, err := config.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if code := Main([]string{"sync"}, env); code != 1 || !strings.Contains(out.String(), "already running") {
		t.Fatalf("exit %d: %s", code, out)
	}
}
