//go:build windows

package schedule

import (
	"os"
	"os/exec"
	"syscall"
)

func currentUser() string { return os.Getenv("USERNAME") }

// hide keeps helper programs (schtasks) from flashing a console window.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
