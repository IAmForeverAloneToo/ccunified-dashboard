package schedule

import (
	"context"
	"runtime"
)

// Install sets up (or replaces) the background sync at the given interval.
func (s *Scheduler) Install(ctx context.Context, minutes int) (string, error) {
	if err := validInterval(minutes); err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "windows":
		return s.installWindows(ctx, minutes)
	case "linux":
		if s.systemdAvailable(ctx) {
			s.removeCron(ctx) // never run both
			return s.installSystemd(ctx, minutes)
		}
		if s.cronAvailable(ctx) {
			return s.installCron(ctx, minutes)
		}
		return "", ErrUnsupported
	default:
		return "", ErrUnsupported
	}
}

// Remove deletes the background sync, if any.
func (s *Scheduler) Remove(ctx context.Context) error {
	switch runtime.GOOS {
	case "windows":
		return s.removeWindows(ctx)
	case "linux":
		if s.systemdAvailable(ctx) {
			if err := s.removeSystemd(ctx); err != nil {
				return err
			}
		}
		if s.cronAvailable(ctx) {
			return s.removeCron(ctx)
		}
		return nil
	default:
		return nil
	}
}

// Current reports what is installed.
func (s *Scheduler) Current(ctx context.Context) Status {
	switch runtime.GOOS {
	case "windows":
		return s.statusWindows(ctx)
	case "linux":
		if s.systemdAvailable(ctx) {
			if st := s.statusSystemd(ctx); st.Installed {
				return st
			}
		}
		if s.cronAvailable(ctx) {
			return s.statusCron(ctx)
		}
	}
	return Status{}
}

// UsesSystemd reports whether Install would use a systemd user timer (and
// so whether lingering matters).
func (s *Scheduler) UsesSystemd(ctx context.Context) bool {
	return runtime.GOOS == "linux" && !s.System && s.systemdAvailable(ctx)
}
