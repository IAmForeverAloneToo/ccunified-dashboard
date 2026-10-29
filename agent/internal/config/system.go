package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// A system-wide install (set up by root or SYSTEM with an enrollment key)
// connects every user account on the computer: each account with usage
// becomes its own machine on the dashboard, named "HOST (user)". Its files
// live in a folder only administrators can read:
//
//	Windows: %ProgramData%\ccunified\
//	Linux:   /var/lib/ccunified/
//
// system.json there holds the dashboard and the enrollment key, and each
// account has its own settings folder in users\<name>\.
// CCUNIFIED_SYSTEM_HOME overrides the folder (tests).

// SystemDir is the system-wide settings folder.
func SystemDir() string {
	if d := os.Getenv("CCUNIFIED_SYSTEM_HOME"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "ccunified")
	}
	return "/var/lib/ccunified"
}

// ProfileDir is the settings folder for one user account in a system-wide install.
func ProfileDir(user string) string {
	return filepath.Join(SystemDir(), "users", user)
}

// System is a system-wide install's settings.
type System struct {
	DashboardURL        string `json:"dashboard_url"`
	EnrollKey           string `json:"enroll_key"`
	SyncIntervalMinutes int    `json:"sync_interval_minutes"`
}

// ErrNoSystem means there's no system-wide install on this computer.
var ErrNoSystem = errors.New("ccunified isn't installed for all users on this computer")

// LoadSystem reads system.json.
func LoadSystem() (*System, error) {
	data, err := os.ReadFile(filepath.Join(SystemDir(), "system.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoSystem
	}
	if err != nil {
		return nil, err
	}
	var s System
	if err := json.Unmarshal(data, &s); err != nil || s.DashboardURL == "" || s.EnrollKey == "" {
		return nil, fmt.Errorf("system.json in %s is damaged; run: ccunified setup --all-users", SystemDir())
	}
	return &s, nil
}

// Save writes system.json, readable only by administrators.
func (s *System) Save() error {
	if err := SecureSystemDir(); err != nil {
		return err
	}
	return writeJSONIn(SystemDir(), "system.json", s)
}

// SecureSystemDir creates the system-wide settings folder, private to
// administrators, or makes sure the one there is (see makePrivateDir):
// ProgramData lets any account create folders, so someone could have
// created it first, and on Linux it must be root's.
func SecureSystemDir() error { return makePrivateDir(SystemDir()) }

// PrepareProfileDir does the same for an account's settings folder (and
// the users folder it's in), before that account's sync writes to it.
func PrepareProfileDir(user string) error {
	if user == "" || user == "." || user == ".." || strings.ContainsAny(user, `/\`) {
		return fmt.Errorf("%q can't be a settings folder's name", user)
	}
	for _, dir := range []string{SystemDir(), filepath.Join(SystemDir(), "users"), ProfileDir(user)} {
		if err := makePrivateDir(dir); err != nil {
			return err
		}
	}
	return nil
}

// RemoveSystem deletes the system-wide settings, including every account's.
func RemoveSystem() error { return os.RemoveAll(SystemDir()) }
