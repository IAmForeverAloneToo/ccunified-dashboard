package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/install"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/schedule"
)

// A system-wide install syncs each user account in a process of its own:
// `ccunified sync` with the account's settings folder (CCUNIFIED_HOME) and
// the account itself in these variables, so ccusage reads that account's
// logs (and, on Linux, runs as that account).
const (
	envAccountName = "CCUNIFIED_ACCOUNT_NAME"
	envAccountHome = "CCUNIFIED_ACCOUNT_HOME"
	envAccountUID  = "CCUNIFIED_ACCOUNT_UID"
	envAccountGID  = "CCUNIFIED_ACCOUNT_GID"
)

// accountFromEnv is the account this process syncs for a system-wide
// install, or nil.
func accountFromEnv() *profiles.Profile {
	name, home := os.Getenv(envAccountName), os.Getenv(envAccountHome)
	if name == "" || home == "" {
		return nil
	}
	uid, err1 := strconv.Atoi(os.Getenv(envAccountUID))
	gid, err2 := strconv.Atoi(os.Getenv(envAccountGID))
	if err1 != nil || err2 != nil {
		uid, gid = -1, -1
	}
	return &profiles.Profile{Name: name, Home: home, UID: uid, GID: gid}
}

// ownSetup reports whether an account set ccunified up itself (its own
// settings exist), so the system-wide install leaves it alone rather than
// uploading its usage twice.
func ownSetup(p profiles.Profile) bool {
	var dir string
	switch runtime.GOOS {
	case "windows":
		dir = filepath.Join(p.Home, "AppData", "Roaming", "ccunified")
	default:
		dir = filepath.Join(p.Home, ".config", "ccunified")
	}
	_, err := os.Stat(filepath.Join(dir, "config.json"))
	return err == nil
}

// syncAllUsers is `ccunified sync --all-users`: one sync per user account.
func syncAllUsers(ctx context.Context, env *Env, full, quiet bool) error {
	if !profiles.Privileged() {
		return errors.New("syncing every account needs root or SYSTEM")
	}
	if _, err := config.LoadSystem(); err != nil {
		return err
	}
	// This run's own lock and log are in the system-wide folder.
	os.Setenv("CCUNIFIED_HOME", config.SystemDir())
	unlock, err := config.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	accounts, err := profiles.List()
	if err != nil {
		return fmt.Errorf("couldn't list the user accounts: %w", err)
	}
	failed := 0
	for _, a := range accounts {
		var line string
		if ownSetup(a) {
			line = "set up by the account itself; skipped"
		} else {
			args := []string{"sync"}
			if full {
				args = append(args, "--full")
			}
			out, err := runAs(ctx, exe, a, args...)
			line = summaryLine(out)
			if err != nil {
				line = lastLine(out)
				failed++
				if line == "" {
					line = err.Error()
				}
				line = "failed: " + line
			}
		}
		config.Log("%s: %s", a.Name, line)
		if !quiet {
			env.Printf("  %s: %s\n", a.Name, line)
		}
	}
	if len(accounts) == 0 && !quiet {
		env.Printf("  No user accounts found.\n")
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d account(s) didn't sync; see %s", failed, len(accounts), filepath.Join(config.SystemDir(), "ccunified.log"))
	}
	return nil
}

// runAs runs this program for one account (see envAccountName).
func runAs(ctx context.Context, exe string, a profiles.Profile, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Env = append(os.Environ(),
		"CCUNIFIED_HOME="+config.ProfileDir(a.Name),
		"CCUNIFIED_SYSTEM_HOME="+config.SystemDir(),
		envAccountName+"="+a.Name,
		envAccountHome+"="+a.Home,
		envAccountUID+"="+strconv.Itoa(a.UID),
		envAccountGID+"="+strconv.Itoa(a.GID),
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	hideConsole(cmd)
	err := cmd.Run()
	return out.String(), err
}

// runProgram runs the installed program and returns what it printed.
func runProgram(ctx context.Context, exe string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, exe, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	hideConsole(cmd)
	err := cmd.Run()
	return out.String(), err
}

// summaryLine is the first line a sync printed, other than notes.
func summaryLine(s string) string {
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "Note:") {
			return l
		}
	}
	return lastLine(s)
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// uninstallAllUsers removes a system-wide install: its schedule, settings
// (every account's) and program.
func uninstallAllUsers(ctx context.Context, env *Env, sys *config.System) {
	names := allUsersMachines()
	if err := schedulerForAll().Remove(ctx); err != nil {
		env.Printf("  ! Couldn't remove the background sync: %v\n", err)
	} else {
		env.Printf("  ✓ Removed the background sync of every account\n")
	}
	if err := config.RemoveSystem(); err != nil {
		env.Printf("  ! Couldn't remove the settings in %s: %v\n", config.SystemDir(), err)
	} else {
		env.Printf("  ✓ Removed the settings of every account\n")
	}
	if err := install.RemoveForAll(); err != nil {
		env.Printf("  ! Couldn't remove the program in %s: %v\n", install.SystemDir(), err)
	} else {
		env.Printf("  ✓ Removed the program\n")
	}
	if len(names) > 0 {
		env.Printf("\nThese machines still appear on %s with their past usage:\n", sys.DashboardURL)
		for _, n := range names {
			env.Printf("  %s\n", n)
		}
		env.Printf("To stop them from ever uploading again, revoke them on the dashboard's Machines page.\n")
	}
}

// schedulerForAll is the scheduler of a system-wide install.
func schedulerForAll() *schedule.Scheduler {
	exe := filepath.Join(install.SystemDir(), "ccunified")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	return schedule.SystemDefault(exe)
}

// allUsersMachines are the dashboard names of a system-wide install's accounts.
func allUsersMachines() []string {
	entries, _ := os.ReadDir(filepath.Join(config.SystemDir(), "users"))
	var names []string
	for _, e := range entries {
		if cfg, err := config.LoadIn(filepath.Join(config.SystemDir(), "users", e.Name())); err == nil {
			names = append(names, cfg.MachineName)
		}
	}
	return names
}
