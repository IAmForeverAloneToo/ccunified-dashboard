// Package schedule runs `ccunified sync` in the background at the chosen
// interval, using the operating system's own scheduler:
//
//   - Windows: a Task Scheduler task for the current user that runs the
//     windowless ccunifiedw.exe (no console window ever appears), and runs
//     missed syncs when the computer wakes up.
//   - Linux: a systemd user timer (kept running while you're logged out by
//     enabling "lingering"), or a crontab entry where systemd isn't available.
package schedule

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Runner runs a command and returns its combined output (replaced in tests).
type Runner func(ctx context.Context, stdin string, name string, args ...string) (string, error)

func execRunner(ctx context.Context, stdin string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hide(cmd)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

// Scheduler installs and removes the background sync.
type Scheduler struct {
	Run Runner
	// Exe is the program the schedule runs (on Windows, the windowless variant).
	Exe string
	// Home is the user's home directory (systemd units, defaults).
	Home string
	// User is the login name (Windows task name, lingering).
	User string
}

// Default returns a scheduler for this machine and the installed program.
func Default() (*Scheduler, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, _ := os.UserHomeDir()
	return &Scheduler{Run: execRunner, Exe: exe, Home: home, User: currentUser()}, nil
}

// ErrUnsupported means no supported scheduler was found.
var ErrUnsupported = errors.New("no supported scheduler found on this system")

// Status describes the installed schedule.
type Status struct {
	Installed bool
	Kind      string // "Task Scheduler", "systemd timer", "cron"
	Detail    string
}

func (s Status) String() string {
	if !s.Installed {
		return "not set up (run: ccunified setup)"
	}
	if s.Detail != "" {
		return s.Kind + ", " + s.Detail
	}
	return s.Kind
}

func intervalText(minutes int) string {
	return fmt.Sprintf("every %d minutes", minutes)
}

func validInterval(minutes int) error {
	switch minutes {
	case 15, 30, 60:
		return nil
	}
	return fmt.Errorf("unsupported interval %d", minutes)
}
