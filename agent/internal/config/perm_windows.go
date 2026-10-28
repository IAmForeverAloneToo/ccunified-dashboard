//go:build windows

package config

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// On Windows, Chmod only toggles read-only; the user's AppData folder is
// already private to the user, so a failure here is not a problem.
func isUnsupported(error) bool { return true }

// restrictToAdmins makes a folder (and what's in it) readable only by
// SYSTEM and Administrators: ProgramData lets every user read by default.
func restrictToAdmins(dir string) error {
	cmd := exec.Command("icacls", dir, "/inheritance:r",
		"/grant:r", "*S-1-5-18:(OI)(CI)F", "/grant:r", "*S-1-5-32-544:(OI)(CI)F")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("couldn't make %s private to administrators: %v: %s", dir, err, strings.TrimSpace(string(out)))
	}
	return nil
}
