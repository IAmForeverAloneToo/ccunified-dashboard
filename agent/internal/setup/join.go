package setup

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

// Join connects this machine to an existing dashboard. An admin approves
// the request by typing the code shown here into the dashboard.
func Join(ctx context.Context, p *prompt.Prompter, h *Hooks, dashboardURL string) error {
	p.Printf("\nJoin an existing dashboard\n\n")
	var c *client.Client
	url, err := p.Text("Dashboard address (like https://usage.example.com)", dashboardURL, func(s string) error {
		u, err := config.NormalizeURL(s)
		if err != nil {
			return err
		}
		c = client.New(u, "")
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if _, err := c.Health(checkCtx); err != nil {
			return fmt.Errorf("no ccunified dashboard answered at %s. Check the address, and that the dashboard is set up", u)
		}
		return nil
	})
	if err != nil {
		return err
	}
	url, _ = config.NormalizeURL(url)

	name, err := p.Text("Name for this machine on the dashboard", defaultMachineName(), ValidMachineName)
	if err != nil {
		return err
	}
	interval, err := askInterval(p)
	if err != nil {
		return err
	}

	for {
		start, err := c.PairStart(ctx, client.PairStartRequest{
			MachineName:         strings.TrimSpace(name),
			OS:                  runtime.GOOS,
			Arch:                runtime.GOARCH,
			AgentVersion:        version.Version,
			SyncIntervalMinutes: interval,
		})
		if client.IsCode(err, 429, "too_many_requests") || client.IsCode(err, 429, "too_many_pending") {
			return errors.New("the dashboard has too many machines waiting to join right now; try again in a few minutes")
		}
		if err != nil {
			return fmt.Errorf("couldn't ask the dashboard to add this machine: %w", err)
		}

		p.Printf("\n")
		p.Printf("  ┌────────────────────────────┐\n")
		p.Printf("  │   Your code:  %-12s │\n", start.UserCode)
		p.Printf("  └────────────────────────────┘\n\n")
		p.Printf("An admin of the dashboard must approve this machine:\n")
		p.Printf("  1. Open %s\n", start.VerificationURL)
		p.Printf("  2. Enter the code %s\n", start.UserCode)
		p.Printf("The code works for %d minutes. Waiting for approval…\n", start.ExpiresIn/60)

		poll, err := waitForApproval(ctx, c, h, start)
		if err != nil {
			return err
		}
		switch poll.Status {
		case "approved":
			p.Printf("\nApproved! This machine is \"%s\" on the dashboard.\n\n", poll.Machine.Name)
			cfg := &config.Config{
				DashboardURL:        url,
				MachineID:           poll.Machine.ID,
				MachineName:         poll.Machine.Name,
				Token:               poll.Token,
				Timezone:            poll.Timezone,
				SyncIntervalMinutes: interval,
			}
			return finish(ctx, p, h, cfg)
		case "denied":
			return errors.New("the request was denied on the dashboard")
		default:
			again, err := p.Confirm("\nThe code expired before it was approved. Get a new code?", true)
			if err != nil {
				return err
			}
			if !again {
				return errors.New("setup cancelled")
			}
		}
	}
}

func waitForApproval(ctx context.Context, c *client.Client, h *Hooks, start *client.PairStart) (*client.PairPoll, error) {
	interval := time.Duration(start.Interval) * time.Second
	if interval < 2*time.Second {
		interval = 5 * time.Second
	}
	deadline := h.now().Add(time.Duration(start.ExpiresIn)*time.Second + 30*time.Second)
	failures := 0
	for h.now().Before(deadline) {
		if err := h.sleep(ctx, interval); err != nil {
			return nil, err
		}
		poll, err := c.PairPoll(ctx, start.DeviceCode)
		if err != nil {
			failures++
			if failures >= 6 {
				return nil, fmt.Errorf("lost contact with the dashboard while waiting: %w", err)
			}
			continue
		}
		failures = 0
		if poll.Status != "pending" {
			return poll, nil
		}
	}
	return &client.PairPoll{Status: "expired"}, nil
}
