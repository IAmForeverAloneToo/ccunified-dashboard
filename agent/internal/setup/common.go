// Package setup is the `ccunified setup` wizard: create a new dashboard on
// Cloudflare, or join this machine to an existing one.
package setup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
)

// Hooks connect the wizard to the rest of the program (and to fakes in tests).
type Hooks struct {
	// InstallSchedule sets up the background sync. It returns a short
	// description of what was set up.
	InstallSchedule func(cfg *config.Config) (string, error)
	// FirstSync uploads this machine's history right away.
	FirstSync func(ctx context.Context) (string, error)
	// Sleep waits between polls (replaced in tests).
	Sleep func(ctx context.Context, d time.Duration) error
	// Now is replaced in tests.
	Now func() time.Time
	// CheckOnline checks that a dashboard answers at url (replaced in tests).
	CheckOnline func(ctx context.Context, url string) error
	// Published reports whether public DNS has an address for a new
	// dashboard's hostname yet. If set, the wizard waits for it before its
	// first visit, so this computer's DNS never caches "doesn't exist".
	Published func(ctx context.Context, host string) (bool, error)
}

func (h *Hooks) sleep(ctx context.Context, d time.Duration) error {
	if h.Sleep != nil {
		return h.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (h *Hooks) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// ValidMachineName mirrors the dashboard's rule: 1–64 characters, no control characters.
func ValidMachineName(s string) error {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 64 {
		return errors.New("use 1 to 64 characters")
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return errors.New("the name can't contain control characters")
		}
	}
	return nil
}

func defaultMachineName() string {
	name, err := os.Hostname()
	if err != nil || ValidMachineName(name) != nil {
		return "My computer"
	}
	return name
}

func askInterval(p *prompt.Prompter) (int, error) {
	i, err := p.Choose("How often should this machine upload its usage?",
		[]string{"Every 15 minutes", "Every 30 minutes", "Every 60 minutes"}, 0)
	if err != nil {
		return 0, err
	}
	return config.ValidIntervals[i], nil
}

// finish saves the configuration, starts the background schedule and runs
// the first upload. Problems after saving are reported, not fatal: the
// machine is connected and the next run will catch up. The sync state of a
// machine it replaces is started afresh, so the whole history is uploaded.
func finish(ctx context.Context, p *prompt.Prompter, h *Hooks, cfg *config.Config) error {
	if err := cfg.SaveNew(); err != nil {
		return fmt.Errorf("couldn't save this machine's settings: %w", err)
	}
	config.Log("set up: dashboard %s, machine %q", cfg.DashboardURL, cfg.MachineName)
	p.Printf("  ✓ Saved this machine's settings\n")
	if h.InstallSchedule != nil {
		desc, err := h.InstallSchedule(cfg)
		if err != nil {
			p.Printf("  ! Couldn't set up the background sync: %v\n", err)
			p.Printf("    Fix the problem above, then run: ccunified setup --schedule-only\n")
		} else {
			p.Printf("  ✓ %s\n", desc)
		}
	} else {
		p.Printf("  - No background sync was set up. Run \"ccunified sync\" yourself, or\n")
		p.Printf("    set it up later with: ccunified setup --schedule-only\n")
	}
	if h.FirstSync != nil {
		p.Printf("  … Uploading this machine's usage history\n")
		msg, err := h.FirstSync(ctx)
		if err != nil {
			p.Printf("  ! The first upload didn't work: %v\n", err)
			p.Printf("    It will be retried automatically. To try now, run: ccunified sync\n")
		} else {
			p.Printf("  ✓ %s\n", msg)
		}
	}
	return nil
}
