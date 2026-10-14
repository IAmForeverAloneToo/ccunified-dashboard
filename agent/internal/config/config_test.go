package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestNormalizeURL(t *testing.T) {
	ok := map[string]string{
		"https://usage.example.com":    "https://usage.example.com",
		"https://usage.example.com/":   "https://usage.example.com",
		"usage.example.com":            "https://usage.example.com",
		"  https://Usage.Example.com ": "https://Usage.Example.com",
		"http://127.0.0.1:8787":        "http://127.0.0.1:8787",
		"http://localhost:8787":        "http://localhost:8787",
	}
	for in, want := range ok {
		got, err := NormalizeURL(in)
		if err != nil || got != want {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{
		"", "http://usage.example.com", "ftp://usage.example.com",
		"https://user:pw@usage.example.com", "https://usage.example.com/dashboard", "https://usage.example.com/?x=1",
	} {
		if _, err := NormalizeURL(bad); err == nil {
			t.Errorf("NormalizeURL(%q) accepted", bad)
		}
	}
}

func validConfig() *Config {
	return &Config{
		DashboardURL: "https://usage.example.com", MachineID: "m", MachineName: "PC",
		Token: "ccu_m_abc", Timezone: "America/Toronto", SyncIntervalMinutes: 30,
	}
}

func TestSaveLoadRoundTripIsPrivate(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", filepath.Join(t.TempDir(), "home"))
	if _, err := Load(); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
	c := validConfig()
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	got, err := Load()
	if err != nil || *got != *c {
		t.Fatalf("round trip: %+v, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		dir, _ := Dir()
		info, _ := os.Stat(filepath.Join(dir, "config.json"))
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config.json mode %v, want 0600", info.Mode().Perm())
		}
		dinfo, _ := os.Stat(dir)
		if dinfo.Mode().Perm() != 0o700 {
			t.Fatalf("folder mode %v, want 0700", dinfo.Mode().Perm())
		}
	}
}

func TestValidateRejectsBadSettings(t *testing.T) {
	for _, mutate := range []func(*Config){
		func(c *Config) { c.DashboardURL = "http://example.com" },
		func(c *Config) { c.Token = "" },
		func(c *Config) { c.Timezone = "Mars/Base" },
		func(c *Config) { c.Timezone = "" },
		func(c *Config) { c.SyncIntervalMinutes = 5 },
	} {
		c := validConfig()
		mutate(c)
		if err := c.Validate(); err == nil {
			t.Errorf("accepted %+v", c)
		}
	}
}

func TestStateSurvivesDamage(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	dir, _ := Dir()
	os.WriteFile(filepath.Join(dir, "state.json"), []byte("{broken"), 0o600)
	if s := LoadState(); s.LastError != "" || !s.LastSuccessAt.IsZero() {
		t.Fatalf("damaged state not reset: %+v", s)
	}
	s := &State{LastSuccessAt: time.Now().UTC().Truncate(time.Second), BackfillTimezone: "UTC"}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	if got := LoadState(); !got.LastSuccessAt.Equal(s.LastSuccessAt) || got.BackfillTimezone != "UTC" {
		t.Fatalf("round trip: %+v", got)
	}
}

func TestLock(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	unlock, err := Lock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lock(); !errors.Is(err, ErrBusy) {
		t.Fatalf("second lock: %v", err)
	}
	unlock()
	unlock2, err := Lock()
	if err != nil {
		t.Fatalf("lock after unlock: %v", err)
	}
	defer unlock2()

	// A lock left behind by a crashed sync is taken over after 30 minutes.
	dir, _ := Dir()
	old := time.Now().Add(-time.Hour)
	os.Chtimes(filepath.Join(dir, "sync.lock"), old, old)
	if _, err := Lock(); err != nil {
		t.Fatalf("stale lock not taken over: %v", err)
	}
}
