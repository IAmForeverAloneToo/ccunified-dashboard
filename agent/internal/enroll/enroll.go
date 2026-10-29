// Package enroll joins this machine to a dashboard with an enrollment key:
// it asks to join, then, on each sync, whether an admin approved it yet.
package enroll

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

var (
	// ErrWaiting means an admin hasn't approved this machine yet.
	ErrWaiting = errors.New("waiting for approval on the dashboard")
	// ErrDenied means an admin denied this machine's request to join.
	ErrDenied = errors.New("the request to join was denied on the dashboard; to ask again, run ccunified setup with an enrollment key")
	// ErrExpired means nobody approved the request within 30 days.
	ErrExpired = errors.New("the request to join expired before it was approved; to ask again, run ccunified setup with an enrollment key")
)

// Request asks the dashboard at url to add this machine with an enrollment
// key, and saves the request (pending.json) for later syncs to follow up.
func Request(ctx context.Context, url, key, name string, interval int, now time.Time) (*config.Pending, error) {
	res, err := client.New(url, "").Enroll(ctx, client.EnrollRequest{
		EnrollKey:           key,
		MachineName:         name,
		OS:                  runtime.GOOS,
		Arch:                runtime.GOARCH,
		AgentVersion:        version.Version,
		SyncIntervalMinutes: interval,
	})
	if err != nil {
		return nil, explain(err)
	}
	p := &config.Pending{
		DashboardURL:        url,
		DeviceCode:          res.DeviceCode,
		MachineName:         res.MachineName,
		SyncIntervalMinutes: interval,
		RequestedAt:         now,
		ExpiresAt:           now.Add(time.Duration(res.ExpiresIn) * time.Second),
		Status:              "waiting",
	}
	if err := p.Save(); err != nil {
		return nil, fmt.Errorf("couldn't save the request to join: %w", err)
	}
	config.Log("asked %s to join as %q with an enrollment key", url, p.MachineName)
	return p, nil
}

// CheckKey checks that the dashboard at url accepts an enrollment key,
// without using it.
func CheckKey(ctx context.Context, url, key string) error {
	if err := client.New(url, "").CheckEnrollKey(ctx, key); err != nil {
		return explain(err)
	}
	return nil
}

// explain turns the dashboard's refusals into sentences.
func explain(err error) error {
	var apiErr *client.APIError
	if !errors.As(err, &apiErr) {
		return fmt.Errorf("couldn't reach the dashboard: %w", err)
	}
	switch {
	case apiErr.Status == http.StatusNotFound:
		return errors.New("this dashboard doesn't accept enrollment keys yet; update it with: ccunified server update")
	case apiErr.Code == "invalid_enroll_key":
		return errors.New("the dashboard doesn't know this enrollment key; check that it was copied whole")
	case apiErr.Code == "enroll_key_revoked":
		return errors.New("this enrollment key was revoked on the dashboard")
	case apiErr.Code == "enroll_key_expired":
		return errors.New("this enrollment key has expired; create a new one on the dashboard's Machines page")
	case apiErr.Code == "enroll_key_used_up":
		return errors.New("this enrollment key has been used for as many machines as it allows")
	case apiErr.Code == "too_many_pending":
		return errors.New("too many machines are waiting for approval on the dashboard; approve or deny some, then try again")
	case apiErr.Code == "too_many_requests":
		return errors.New("too many wrong enrollment keys were tried from this network; wait 10 minutes")
	}
	return fmt.Errorf("the dashboard refused to add this machine: %w", err)
}

// Check asks the dashboard whether the waiting request was approved. When
// it was, it saves this machine's settings (config.json) and returns them;
// while it waits, it returns ErrWaiting.
//
// The dashboard hands over the upload key only once, so it is kept in
// pending.json before config.json is written: if that fails, the next Check
// finishes from there.
func Check(ctx context.Context, p *config.Pending) (*config.Config, error) {
	switch p.Status {
	case "denied":
		return nil, ErrDenied
	case "expired":
		return nil, ErrExpired
	case "approved":
		return saveApproved(p)
	}
	poll, err := client.New(p.DashboardURL, "").PairPoll(ctx, p.DeviceCode)
	if client.IsCode(err, http.StatusNotFound, "not_found") {
		// Requests are deleted a day after they expire.
		poll, err = &client.PairPoll{Status: "expired"}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("couldn't ask the dashboard about the request to join: %w", err)
	}
	switch poll.Status {
	case "pending":
		return nil, ErrWaiting
	case "approved":
		approved := *p
		approved.Status = "approved"
		approved.MachineID = poll.Machine.ID
		approved.MachineName = poll.Machine.Name
		approved.Token = poll.Token
		approved.Timezone = poll.Timezone
		if err := approved.Save(); err != nil {
			config.Log("approved, but pending.json couldn't be updated: %v", err)
		}
		return saveApproved(&approved)
	case "denied":
		p.Status = "denied"
	default:
		p.Status = "expired"
	}
	p.Save()
	config.Log("request to join %s %s", p.DashboardURL, p.Status)
	return Check(ctx, p)
}

// saveApproved writes the settings of an approved machine (config.json)
// and removes pending.json.
func saveApproved(p *config.Pending) (*config.Config, error) {
	cfg := &config.Config{
		DashboardURL:        p.DashboardURL,
		MachineID:           p.MachineID,
		MachineName:         p.MachineName,
		Token:               p.Token,
		Timezone:            p.Timezone,
		SyncIntervalMinutes: p.SyncIntervalMinutes,
	}
	if err := cfg.SaveNew(); err != nil {
		return nil, fmt.Errorf("approved, but the settings couldn't be saved (the next sync tries again): %w", err)
	}
	config.RemovePending()
	config.Log("approved: machine %q on %s", cfg.MachineName, cfg.DashboardURL)
	return cfg, nil
}
