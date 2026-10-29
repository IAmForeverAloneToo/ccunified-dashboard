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
	if err := ValidateInterval(c.SyncIntervalMinutes); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	return nil
}

// ValidateInterval checks a sync interval against ValidIntervals.
func ValidateInterval(minutes int) error {
	for _, v := range ValidIntervals {
		if v == minutes {
			return nil
		}
	}
	return fmt.Errorf("sync interval must be 15, 30 or 60 minutes, not %d", minutes)
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
	return LoadIn(dir)
}

// LoadIn reads config.json from a settings folder.
func LoadIn(dir string) (*Config, error) {
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
	return writeJSONIn(dir, name, v)
}

func writeJSONIn(dir, name string, v any) error {
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
	// MachineID and DashboardURL say which machine the state belongs to; a
	// state left by another one (setup run again) is started afresh.
	MachineID     string    `json:"machine_id,omitempty"`
	DashboardURL  string    `json:"dashboard_url,omitempty"`
	LastAttemptAt time.Time `json:"last_attempt_at,omitzero"`
	LastSuccessAt time.Time `json:"last_success_at,omitzero"`
	LastError     string    `json:"last_error,omitempty"`
	LastChanged   int       `json:"last_changed_rows"`
	LastDays      int       `json:"last_days"`
	// BackfillTimezone is the time zone in which the full history was last
	// uploaded. When it differs from the configured zone, the next sync
	// uploads everything again.
	BackfillTimezone string `json:"backfill_timezone,omitempty"`
	// BackfillFormat is the upload format of that full upload. When the
	// dashboard starts accepting a newer format (every tool, not just Claude
	// Code), the next sync uploads everything again.
	BackfillFormat int `json:"backfill_format,omitempty"`
	// UploadFormat is the newest upload format both this program and the
	// dashboard accept, as the dashboard last said; 0 means not asked yet.
	UploadFormat  int    `json:"upload_format,omitempty"`
	LatestVersion string `json:"latest_version,omitempty"`
	// Tools are the tools this machine has reported usage for, such as
	// "claude" and "codex".
	Tools []string `json:"tools,omitempty"`
	// LastWarning is a problem the last sync worked around.
	LastWarning string `json:"last_warning,omitempty"`
	// PricesReportedAt is when this machine last sent the dashboard its
	// models' prices from the public price lists (once a day).
	PricesReportedAt time.Time `json:"prices_reported_at,omitzero"`
}

// LoadState reads state.json; a missing or damaged file gives a fresh state.
func LoadState() *State {
	dir, err := Dir()
	if err != nil {
		return &State{}
	}
	return LoadStateIn(dir)
}

// LoadStateIn reads state.json from a settings folder.
func LoadStateIn(dir string) *State {
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

// RecordAttempt notes in state.json a sync that ended before it could
// upload, for `ccunified status`: err says why, or is nil when nothing went
// wrong (the machine waits for approval), which clears an earlier problem.
func RecordAttempt(at time.Time, err error) error {
	s := LoadState()
	if err == nil {
		if s.LastError == "" {
			return nil
		}
		s.LastError = ""
	} else {
		s.LastError = err.Error()
	}
	s.LastAttemptAt = at
	return s.Save()
}

// SaveNew writes config.json for a machine that was just added to a
// dashboard. If it replaces another machine (setup run again, or another
// dashboard), the sync state is started afresh, so the new machine uploads
// its whole history.
func (c *Config) SaveNew() error {
	if err := c.Validate(); err != nil {
		return err
	}
	if old, err := Load(); err != nil || old.MachineID != c.MachineID || old.DashboardURL != c.DashboardURL {
		if err := removeState(); err != nil {
			return err
		}
	}
	return c.Save()
}

func removeState() error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(dir, "state.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
