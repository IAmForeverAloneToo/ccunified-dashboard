// Package config stores this machine's ccunified settings and sync state.
//
// Files live in the user's config folder, readable only by the user:
//
//	Windows: %APPDATA%\ccunified\
//	Linux:   ~/.config/ccunified/ (or $XDG_CONFIG_HOME/ccunified/)
//	macOS:   ~/Library/Application Support/ccunified/
//
// CCUNIFIED_HOME overrides the folder (tests, portable installs).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Dir returns the folder holding config.json, state.json and the log.
func Dir() (string, error) {
	if d := os.Getenv("CCUNIFIED_HOME"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "ccunified"), nil
}

// Config is what setup writes. It holds the machine's upload key, so the
// file is private to the user.
type Config struct {
	DashboardURL        string `json:"dashboard_url"`
	MachineID           string `json:"machine_id"`
	MachineName         string `json:"machine_name"`
	Token               string `json:"token"`
	Timezone            string `json:"timezone"`
	SyncIntervalMinutes int    `json:"sync_interval_minutes"`
}

// ValidIntervals are the sync intervals the dashboard accepts, in minutes.
var ValidIntervals = []int{15, 30, 60}

// ErrNotConfigured means setup has not been run on this machine.
var ErrNotConfigured = errors.New("this machine isn't set up yet; run: ccunified setup")

func (c *Config) Validate() error {
	if _, err := NormalizeURL(c.DashboardURL); err != nil {
		return err
	}
	if !strings.HasPrefix(c.Token, "ccu_m_") {
		return errors.New("config: missing or malformed upload key")
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil || c.Timezone == "" {
		return fmt.Errorf("config: invalid time zone %q", c.Timezone)
	}
	ok := false
	for _, v := range ValidIntervals {
		ok = ok || v == c.SyncIntervalMinutes
	}
	if !ok {
		return fmt.Errorf("config: sync interval must be 15, 30 or 60 minutes, not %d", c.SyncIntervalMinutes)
	}
	return nil
}

// NormalizeURL checks a dashboard address and returns it as "https://host".
// Plain http is accepted only for this computer (local testing).
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw != "" && !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("%q isn't a valid web address", raw)
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", fmt.Errorf("the dashboard address must start with https:// (got %q)", raw)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("use just the dashboard's address, like https://usage.example.com (got %q)", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}

// Load reads config.json. It returns ErrNotConfigured if there is none.
func Load() (*Config, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotConfigured
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("config.json is damaged (%w); run: ccunified setup", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// Save writes config.json atomically, readable only by this user.
func (c *Config) Save() error {
	if err := c.Validate(); err != nil {
		return err
	}
	return writeJSON("config.json", c)
}

// Remove deletes this machine's config, state, lock and log files.
func Remove() error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

func writeJSON(name string, v any) error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, name+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !isUnsupported(err) {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

// State is what each sync records, for `ccunified status` and for deciding
// whether the full history still needs uploading.
type State struct {
	LastAttemptAt time.Time `json:"last_attempt_at,omitzero"`
	LastSuccessAt time.Time `json:"last_success_at,omitzero"`
	LastError     string    `json:"last_error,omitempty"`
	LastChanged   int       `json:"last_changed_rows"`
	LastDays      int       `json:"last_days"`
	// BackfillTimezone is the time zone in which the full history was last
	// uploaded. When it differs from the configured zone, the next sync
	// uploads everything again.
	BackfillTimezone string `json:"backfill_timezone,omitempty"`
	LatestVersion    string `json:"latest_version,omitempty"`
	NoClaudeData     bool   `json:"no_claude_data,omitempty"`
}

// LoadState reads state.json; a missing or damaged file gives a fresh state.
func LoadState() *State {
	dir, err := Dir()
	if err != nil {
		return &State{}
	}
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return &State{}
	}
	var s State
	if json.Unmarshal(data, &s) != nil {
		return &State{}
	}
	return &s
}

func (s *State) Save() error { return writeJSON("state.json", s) }
