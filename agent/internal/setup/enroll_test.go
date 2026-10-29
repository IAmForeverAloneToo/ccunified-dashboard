package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/enroll"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
)

// enrollDashboard answers enrollment requests; polls return status.
type enrollDashboard struct {
	mu       sync.Mutex
	enrolled []map[string]any
	status   string
	refuse   string // an error code for /agent/enroll
	pollCode int    // an HTTP status for polls (503: down, 404: forgotten)
}

func (d *enrollDashboard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch r.URL.Path {
	case "/healthz":
		w.Write([]byte(`{"ok":true,"version":"0.7.0"}`))
	case "/agent/enroll", "/agent/enroll/check":
		if d.refuse != "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": d.refuse})
			return
		}
		if r.URL.Path == "/agent/enroll/check" {
			w.Write([]byte(`{"ok":true}`))
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		d.enrolled = append(d.enrolled, body)
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dev-secret", "machine_name": body["machine_name"].(string) + "-2",
			"expires_in": 30 * 24 * 3600, "interval": 5,
		})
	case "/agent/pair/poll":
		if d.pollCode != 0 {
			w.WriteHeader(d.pollCode)
			json.NewEncoder(w).Encode(map[string]string{"error": map[int]string{404: "not_found"}[d.pollCode]})
			return
		}
		res := map[string]any{"status": d.status}
		if d.status == "approved" {
			res["token"] = "ccu_m_" + strings.Repeat("t", 43)
			res["machine"] = map[string]string{"id": "m-1", "name": "build-01-2"}
			res["timezone"] = "Europe/Berlin"
		}
		json.NewEncoder(w).Encode(res)
	default:
		http.NotFound(w, r)
	}
}

func enrollSetup(t *testing.T) (*enrollDashboard, string, *[]int, *Hooks) {
	t.Helper()
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	d := &enrollDashboard{status: "pending"}
	srv := httptest.NewServer(d)
	t.Cleanup(srv.Close)
	var schedules []int
	h := &Hooks{
		InstallSchedule: func(cfg *config.Config) (string, error) {
			schedules = append(schedules, cfg.SyncIntervalMinutes)
			return "Background sync every 15 minutes", nil
		},
		FirstSync: func(context.Context) (string, error) { return "Uploaded this machine's history", nil },
		Now:       func() time.Time { return time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC) },
	}
	return d, srv.URL, &schedules, h
}

func TestEnrollUserAsksOnceThenFinishesWhenApproved(t *testing.T) {
	d, url, schedules, h := enrollSetup(t)
	o := EnrollOptions{URL: url, Key: "ccu_e_key", Name: "build-01", Interval: 15}
	var out bytes.Buffer
	p := prompt.New(strings.NewReader(""), &out)

	if err := EnrollUser(context.Background(), p, h, o); err != nil {
		t.Fatal(err)
	}
	if len(d.enrolled) != 1 || d.enrolled[0]["enroll_key"] != "ccu_e_key" || d.enrolled[0]["sync_interval_minutes"] != float64(15) {
		t.Fatalf("enroll requests: %v", d.enrolled)
	}
	if !strings.Contains(out.String(), `as "build-01-2"`) {
		t.Errorf("output: %s", out.String())
	}
	pend, err := config.LoadPending()
	if err != nil || pend.DeviceCode != "dev-secret" || pend.Status != "waiting" {
		t.Fatalf("pending: %+v, %v", pend, err)
	}

	// Run again while it waits: nothing new is asked.
	out.Reset()
	if err := EnrollUser(context.Background(), p, h, o); err != nil {
		t.Fatal(err)
	}
	if len(d.enrolled) != 1 || !strings.Contains(out.String(), "waiting for approval") {
		t.Errorf("second run asked again or said: %s", out.String())
	}

	// Approved: the settings are saved, and the first upload runs.
	d.status = "approved"
	out.Reset()
	if err := EnrollUser(context.Background(), p, h, o); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil || cfg.MachineName != "build-01-2" || cfg.SyncIntervalMinutes != 15 || cfg.Timezone != "Europe/Berlin" {
		t.Fatalf("config: %+v, %v", cfg, err)
	}
	if _, err := config.LoadPending(); !errors.Is(err, config.ErrNoPending) {
		t.Errorf("pending.json is still there: %v", err)
	}
	if !strings.Contains(out.String(), "Uploaded this machine's history") {
		t.Errorf("output: %s", out.String())
	}
	if len(*schedules) != 3 || (*schedules)[0] != 15 {
		t.Errorf("schedules: %v", *schedules)
	}
	out.Reset()
	if err := EnrollUser(context.Background(), p, h, o); err != nil || !strings.Contains(out.String(), "already uploads") {
		t.Errorf("fourth run: %v, %s", err, out.String())
	}
}

func TestEnrollUserExplainsRefusals(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	p := prompt.New(strings.NewReader(""), &bytes.Buffer{})
	for code, want := range map[string]string{
		"invalid_enroll_key": "copied whole",
		"enroll_key_revoked": "revoked",
		"enroll_key_expired": "expired",
		"enroll_key_used_up": "as many machines",
	} {
		d.refuse = code
		err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", code, err)
		}
	}
	err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "not-a-key"})
	if err == nil || !strings.Contains(err.Error(), "ccu_e_") {
		t.Errorf("bad key: %v", err)
	}
	err = EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key", Interval: 20})
	if err == nil || !strings.Contains(err.Error(), "15, 30 or 60") {
		t.Errorf("bad interval: %v", err)
	}
}

func TestDeniedAndExpiredRequestsStop(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	p := prompt.New(strings.NewReader(""), &bytes.Buffer{})
	if err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"}); err != nil {
		t.Fatal(err)
	}
	d.status = "denied"
	pend, _ := config.LoadPending()
	if _, err := enroll.Check(context.Background(), pend); !errors.Is(err, enroll.ErrDenied) {
		t.Fatalf("got %v", err)
	}
	// Remembered: the dashboard isn't asked again.
	d.status = "approved"
	pend, _ = config.LoadPending()
	if _, err := enroll.Check(context.Background(), pend); !errors.Is(err, enroll.ErrDenied) {
		t.Fatalf("got %v", err)
	}
	// Setting up again asks anew.
	if err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"}); err != nil {
		t.Fatal(err)
	}
	if len(d.enrolled) != 2 {
		t.Errorf("enroll requests: %d", len(d.enrolled))
	}
}

func TestEnrollUserDoesntAskAgainWhileTheDashboardIsDown(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	p := prompt.New(strings.NewReader(""), &bytes.Buffer{})
	o := EnrollOptions{URL: url, Key: "ccu_e_key"}
	if err := EnrollUser(context.Background(), p, h, o); err != nil {
		t.Fatal(err)
	}
	d.pollCode = http.StatusServiceUnavailable
	if err := EnrollUser(context.Background(), p, h, o); err == nil {
		t.Fatal("the dashboard's trouble was hidden")
	}
	if pend, err := config.LoadPending(); len(d.enrolled) != 1 || err != nil || pend.Status != "waiting" {
		t.Fatalf("asked again: %d request(s), pending %+v, %v", len(d.enrolled), pend, err)
	}
}

func TestEnrollUserRefusesToSwitchAWaitingRequest(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	p := prompt.New(strings.NewReader(""), &bytes.Buffer{})
	other := &config.Pending{DashboardURL: "https://other.example.com", DeviceCode: "x", MachineName: "PC", Status: "waiting"}
	if err := other.Save(); err != nil {
		t.Fatal(err)
	}
	err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"})
	if err == nil || !strings.Contains(err.Error(), "already waiting for approval on https://other.example.com") || len(d.enrolled) != 0 {
		t.Fatalf("err=%v requests=%d", err, len(d.enrolled))
	}
	if pend, _ := config.LoadPending(); pend.DashboardURL != "https://other.example.com" {
		t.Fatalf("pending replaced: %+v", pend)
	}
}

func TestEnrollUserWaitsForARunningSync(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	var out bytes.Buffer
	p := prompt.New(strings.NewReader(""), &out)
	unlock, err := config.Lock()
	if err != nil {
		t.Fatal(err)
	}
	h.Sleep = func(context.Context, time.Duration) error { unlock(); return nil }
	if err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"}); err != nil {
		t.Fatal(err)
	}
	if len(d.enrolled) != 1 || !strings.Contains(out.String(), "Waiting for the running sync") {
		t.Fatalf("requests=%d output: %s", len(d.enrolled), out.String())
	}
	// The lock is released afterwards.
	again, err := config.Lock()
	if err != nil {
		t.Fatal(err)
	}
	again()
}

func TestApprovalSurvivesSettingsThatCantBeSaved(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	p := prompt.New(strings.NewReader(""), &bytes.Buffer{})
	if err := EnrollUser(context.Background(), p, h, EnrollOptions{URL: url, Key: "ccu_e_key"}); err != nil {
		t.Fatal(err)
	}
	// Left by a machine this one replaces.
	(&config.State{BackfillTimezone: "UTC", BackfillFormat: 2, UploadFormat: 2}).Save()
	// config.json can't be written.
	dir, _ := config.Dir()
	blocker := filepath.Join(dir, "config.json")
	os.MkdirAll(filepath.Join(blocker, "x"), 0o700)
	d.status = "approved"
	pend, _ := config.LoadPending()
	if _, err := enroll.Check(context.Background(), pend); err == nil || !strings.Contains(err.Error(), "approved, but") {
		t.Fatalf("got %v", err)
	}
	// The upload key, handed over only once, is kept; the dashboard
	// meanwhile forgot the request.
	d.pollCode = http.StatusNotFound
	os.RemoveAll(blocker)
	pend, err := config.LoadPending()
	if err != nil || pend.Status != "approved" {
		t.Fatalf("pending: %+v, %v", pend, err)
	}
	cfg, err := enroll.Check(context.Background(), pend)
	if err != nil || cfg.MachineID != "m-1" || cfg.Timezone != "Europe/Berlin" || !strings.HasPrefix(cfg.Token, "ccu_m_") {
		t.Fatalf("config: %+v, %v", cfg, err)
	}
	if _, err := config.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := config.LoadPending(); !errors.Is(err, config.ErrNoPending) {
		t.Errorf("pending.json is still there: %v", err)
	}
	// The new machine starts with a fresh state, so it uploads its whole history.
	if st := config.LoadState(); st.BackfillTimezone != "" || st.UploadFormat != 0 {
		t.Errorf("state kept: %+v", st)
	}
}

func TestEnrollAllUsersChecksTheKeyFirst(t *testing.T) {
	d, url, _, h := enrollSetup(t)
	t.Setenv("CCUNIFIED_SYSTEM_HOME", t.TempDir())
	var out bytes.Buffer
	p := prompt.New(strings.NewReader(""), &out)
	var installed, scheduled, synced bool
	ah := AllUsersHooks{
		InstallProgram:  func() (string, error) { installed = true; return "/opt/ccunified/ccunified", nil },
		InstallSchedule: func(string, int) (string, error) { scheduled = true; return "Background sync of every account", nil },
		SyncAll: func(context.Context, string) (string, error) {
			synced = true
			return "  alice: Waiting for approval\n", nil
		},
	}
	d.refuse = "invalid_enroll_key"
	if err := EnrollAllUsers(context.Background(), p, h, ah, EnrollOptions{URL: url, Key: "ccu_e_bad"}); err == nil {
		t.Fatal("a wrong key was accepted")
	}
	if installed {
		t.Error("installed with a wrong key")
	}
	d.refuse = ""
	if err := EnrollAllUsers(context.Background(), p, h, ah, EnrollOptions{URL: url, Key: "ccu_e_key"}); err != nil {
		t.Fatal(err)
	}
	sys, err := config.LoadSystem()
	if err != nil || sys.EnrollKey != "ccu_e_key" || sys.SyncIntervalMinutes != 15 {
		t.Fatalf("system: %+v, %v", sys, err)
	}
	if !installed || !scheduled || !synced || !strings.Contains(out.String(), "alice: Waiting for approval") {
		t.Errorf("installed %v, scheduled %v, synced %v; output: %s", installed, scheduled, synced, out.String())
	}
	if len(d.enrolled) != 0 {
		t.Error("setup itself asked to join; each account asks on its own")
	}
}
