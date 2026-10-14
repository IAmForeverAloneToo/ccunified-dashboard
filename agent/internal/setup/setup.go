package setup

import (
	"context"
	"errors"
	"fmt"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/tzdetect"
)

// Run is `ccunified setup`: choose between creating a dashboard and joining one.
func Run(ctx context.Context, p *prompt.Prompter, h *Hooks, cf CloudflareFactory) error {
	p.Printf("ccunified setup\n\n")
	p.Printf("This connects this computer to a ccunified dashboard, which shows the\n")
	p.Printf("Claude Code usage of all your machines in one place.\n\n")

	if cfg, err := config.Load(); err == nil {
		p.Printf("This machine already uploads to %s as \"%s\".\n", cfg.DashboardURL, cfg.MachineName)
		again, err := p.Confirm("Set it up again? (It will get a new upload key.)", false)
		if err != nil {
			return err
		}
		if !again {
			return nil
		}
	} else if !errors.Is(err, config.ErrNotConfigured) {
		p.Printf("The existing settings can't be read (%v); they will be replaced.\n\n", err)
	}

	choice, err := p.Choose("What would you like to do?", []string{
		"Create a new dashboard (do this on your first machine)",
		"Join an existing dashboard",
	}, -1)
	if err != nil {
		return err
	}
	if choice == 0 {
		return Create(ctx, p, h, cf)
	}
	return Join(ctx, p, h, "")
}

// askTimezone asks for an IANA time zone, offering this computer's zone and
// a search by city or region.
func askTimezone(p *prompt.Prompter) (string, error) {
	local := tzdetect.Local()
	p.Printf("\nWhich time zone should the dashboard's days use? Usage from all\n")
	p.Printf("machines is grouped into days in this zone. You can change it later.\n")
	for {
		answer, err := p.Text("Time zone (or part of a city name to search)", local, nil)
		if err != nil {
			return "", err
		}
		if tzdetect.Valid(answer) {
			return answer, nil
		}
		matches := tzdetect.Search(answer)
		switch {
		case len(matches) == 0:
			p.Printf("  No time zone matches %q. Try a nearby large city, like \"Toronto\" or \"Berlin\".\n", answer)
		case len(matches) == 1:
			ok, err := p.Confirm(fmt.Sprintf("  Use %s?", matches[0]), true)
			if err != nil {
				return "", err
			}
			if ok {
				return matches[0], nil
			}
		case len(matches) > 15:
			p.Printf("  %d zones match %q; be more specific.\n", len(matches), answer)
		default:
			i, err := p.Choose("  Matching time zones:", matches, -1)
			if err != nil {
				return "", err
			}
			return matches[i], nil
		}
	}
}
