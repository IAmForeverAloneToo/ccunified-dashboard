package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Pending is a request to join a dashboard with an enrollment key that an
// admin hasn't approved yet. Each sync asks the dashboard about it until it
// is approved (and config.json is written) or denied, or it expires.
type Pending struct {
	DashboardURL        string    `json:"dashboard_url"`
	DeviceCode          string    `json:"device_code"`
	MachineName         string    `json:"machine_name"`
	SyncIntervalMinutes int       `json:"sync_interval_minutes"`
	RequestedAt         time.Time `json:"requested_at"`
	ExpiresAt           time.Time `json:"expires_at"`
	// Status is "waiting", or "denied" or "expired" once the dashboard says
	// so. It is "approved" when the dashboard handed over the upload key but
	// config.json couldn't be written yet: the next sync finishes from here.
	Status string `json:"status"`
	// Set once approved: the machine's id, upload key and the dashboard's
	// time zone (MachineName is then the name it was given).
	MachineID string `json:"machine_id,omitempty"`
	Token     string `json:"token,omitempty"`
	Timezone  string `json:"timezone,omitempty"`
}

// ErrNoPending means no request to join is waiting.
var ErrNoPending = errors.New("no request to join a dashboard is waiting")

// LoadPending reads pending.json.
func LoadPending() (*Pending, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	return LoadPendingIn(dir)
}

// LoadPendingIn reads pending.json from a settings folder.
func LoadPendingIn(dir string) (*Pending, error) {
	data, err := os.ReadFile(filepath.Join(dir, "pending.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoPending
	}
	if err != nil {
		return nil, err
	}
	var p Pending
	if err := json.Unmarshal(data, &p); err != nil || p.DeviceCode == "" {
		return nil, fmt.Errorf("pending.json is damaged; run: ccunified setup")
	}
	return &p, nil
}

// Save writes pending.json, readable only by this user (it holds a secret).
func (p *Pending) Save() error { return writeJSON("pending.json", p) }

// RemovePending deletes pending.json, if any.
func RemovePending() error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(dir, "pending.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
