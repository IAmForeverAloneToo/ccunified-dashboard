package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
)

// pairingDashboard answers pairing requests: each request's polls return
// the scripted statuses in order.
type pairingDashboard struct {
	mu      sync.Mutex
	script  [][]string // per started request
	started []map[string]any
	polls   int
	current []string
}

func (d *pairingDashboard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch r.URL.Path {
	case "/healthz":
		w.Write([]byte(`{"ok":true,"version":"0.1.0"}`))
	case "/agent/pair/start":
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		d.started = append(d.started, body)
		d.current = d.script[len(d.started)-1]
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dev-secret", "user_code": "K7QX-82MD", "verification_url": "https://dash.example/approve",
			"expires_in": 600, "interval": 5,
		})
	case "/agent/pair/poll":
		d.polls++
		status := d.current[0]
		if len(d.current) > 1 {
			d.current = d.current[1:]
		}
		res := map[string]any{"status": status}
		if status == "approved" {
			res["token"] = "ccu_m_" + strings.Repeat("t", 43)
			res["machine"] = map[string]string{"id": "m-1", "name": "Studio PC"}
			res["timezone"] = "Europe/Berlin"
		}
		json.NewEncoder(w).Encode(res)
	default:
		http.NotFound(w, r)
	}
}

func runJoin(t *testing.T, d *pairingDashboard, answers string) (error, string, *Hooks, *[]string) {
	t.Helper()
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	srv := httptest.NewServer(d)
	t.Cleanup(srv.Close)
	var calls []string
	clock := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	h := &Hooks{
		Sleep: func(context.Context, time.Duration) error { clock = clock.Add(5 * time.Second); return nil },
		Now:   func() time.Time { return clock },
		InstallSchedule: func(cfg *config.Config) (string, error) {
			calls = append(calls, "schedule")
			return "Background sync every 15 minutes", nil
		},
		FirstSync: func(context.Context) (string, error) {
			calls = append(calls, "sync")
			return "Uploaded 3 days of history", nil
		},
	}
	out := &bytes.Buffer{}
	answers = strings.ReplaceAll(answers, "URL", srv.URL)
	err := Join(context.Background(), prompt.New(strings.NewReader(answers), out), h, "")
	return err, out.String(), h, &calls
}

func TestJoinApproved(t *testing.T) {
	d := &pairingDashboard{script: [][]string{{"pending", "pending", "approved"}}}
	// A typo first (no dashboard there), then the right address, a name, the default interval.
	err, out, _, calls := runJoin(t, d, "http://127.0.0.1:1\nURL\nStudio PC\n\n")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "no ccunified dashboard answered") || !strings.Contains(out, "K7QX-82MD") {
		t.Fatalf("output:\n%s", out)
	}
	if d.started[0]["machine_name"] != "Studio PC" || d.started[0]["sync_interval_minutes"] != float64(15) {
		t.Fatalf("start request: %v", d.started[0])
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MachineName != "Studio PC" || cfg.Timezone != "Europe/Berlin" || cfg.MachineID != "m-1" || !strings.HasPrefix(cfg.DashboardURL, "http://127.0.0.1:") {
		t.Fatalf("config: %+v", cfg)
	}
	if strings.Join(*calls, ",") != "schedule,sync" {
		t.Fatalf("hooks: %v", *calls)
	}
}

func TestJoinDenied(t *testing.T) {
	d := &pairingDashboard{script: [][]string{{"pending", "denied"}}}
	err, out, _, calls := runJoin(t, d, "URL\nLaptop\n3\n")
	if err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("got %v\n%s", err, out)
	}
	if len(*calls) != 0 {
		t.Fatal("nothing should be set up after a denial")
	}
	if _, err := config.Load(); err == nil {
		t.Fatal("config saved after denial")
	}
}

func TestJoinExpiredThenRetried(t *testing.T) {
	d := &pairingDashboard{script: [][]string{{"expired"}, {"approved"}}}
	err, out, _, _ := runJoin(t, d, "URL\nLaptop\n2\ny\n")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if len(d.started) != 2 || d.started[1]["sync_interval_minutes"] != float64(30) {
		t.Fatalf("started: %v", d.started)
	}
}

func TestValidMachineName(t *testing.T) {
	for _, bad := range []string{"", "   ", strings.Repeat("x", 65), "bell\a"} {
		if ValidMachineName(bad) == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if err := ValidMachineName("Office PC (2)"); err != nil {
		t.Error(err)
	}
}
