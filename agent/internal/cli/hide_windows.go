//go:build windows

package cli

import (
	"os/exec"
	"syscall"
)

// hideConsole keeps a program run by the windowless scheduled sync from
// opening a console window.
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
