package schedule

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/ccusage"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
)

// TestIntegrationScheduledSyncRuns installs the real background schedule
// (Windows Task Scheduler, or a systemd user timer on Linux), triggers it,
// and waits for the scheduled program to upload to a local fake dashboard.
//
// It changes this user's real scheduler and ccunified settings, so it only
// runs with CCUNIFIED_TEST_SCHEDULER=1 (CI) and refuses if ccunified is
// already set up for this user.
func TestIntegrationScheduledSyncRuns(t *testing.T) {
	if os.Getenv("CCUNIFIED_TEST_SCHEDULER") != "1" {
		t.Skip("set CCUNIFIED_TEST_SCHEDULER=1 to run (changes this user's scheduler)")
	}
	ctx := context.Background()
	os.Unsetenv("CCUNIFIED_HOME") // the scheduled run uses the default folder
	if _, err := config.Load(); err == nil {
		t.Fatal("ccunified is already set up for this user; refusing to overwrite it")
	}

	// Build the program (and on Windows its windowless twin) next to the pinned ccusage.
	dir := t.TempDir()
	exe := filepath.Join(dir, "ccunified")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := func(out string, extraLdflags string) {
		cmd := exec.Command("go", "build", "-ldflags", extraLdflags, "-o", out, "../../cmd/ccunified")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build: %v\n%s", err, b)
		}
	}
	build(exe, "")
	if runtime.GOOS == "windows" {
		build(filepath.Join(dir, "ccunifiedw.exe"), "-H=windowsgui")
	}
	pinned, err := os.ReadFile(filepath.Join("..", "ccusage", "bin", runtime.GOOS+"-"+runtime.GOARCH, ccusage.ExeName()))
	if err != nil {
		t.Fatalf("pinned ccusage not fetched: %v", err)
	}
	os.WriteFile(filepath.Join(dir, ccusage.ExeName()), pinned, 0o755)

	var uploads atomic.Int32
	dash := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		if r.URL.Path == "/agent/ingest" {
			uploads.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "changed_rows": 0, "timezone": "UTC", "server_version": "test"})
			return
		}
		http.NotFound(w, r)
	}))
	defer dash.Close()

	cfg := &config.Config{
		DashboardURL: dash.URL, MachineID: "m", MachineName: "CI runner",
		Token: "ccu_m_" + strings.Repeat("c", 43), Timezone: "UTC", SyncIntervalMinutes: 15,
	}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	defer config.Remove()

	home, _ := os.UserHomeDir()
	s := &Scheduler{Run: execRunner, Exe: exe, Home: home, User: currentUser()}
	desc, err := s.Install(ctx, 15)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Remove(ctx)
	t.Logf("installed: %s", desc)
	if st := s.Current(ctx); !st.Installed || !strings.Contains(st.Detail, "every 15 minutes") {
		t.Fatalf("status after install: %+v", st)
	}

	// Run it now instead of waiting up to 15 minutes.
	switch {
	case runtime.GOOS == "windows":
		if err := s.RunNowWindows(ctx); err != nil {
			t.Fatal(err)
		}
	case s.UsesSystemd(ctx):
		if out, err := s.Run(ctx, "", "systemctl", "--user", "start", unitName+".service"); err != nil {
			t.Fatalf("start: %v %s", err, out)
		}
	default:
		t.Log("cron only: installation checked; not waiting for cron to fire")
		return
	}
	deadline := time.Now().Add(3 * time.Minute)
	for uploads.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
	}
	if uploads.Load() == 0 {
		logPath, _ := config.LogPath()
		logText, _ := os.ReadFile(logPath)
		t.Fatalf("the scheduled sync never uploaded. Log:\n%s", logText)
	}
	state := config.LoadState()
	if state.LastSuccessAt.IsZero() {
		t.Fatalf("state not updated by the scheduled run: %+v", state)
	}
	t.Logf("scheduled sync uploaded %d time(s)", uploads.Load())

	if err := s.Remove(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Current(ctx).Installed {
		t.Fatal("schedule still installed after Remove")
	}
}
