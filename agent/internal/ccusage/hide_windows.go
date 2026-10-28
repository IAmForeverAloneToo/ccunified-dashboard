//go:build windows

package ccusage

import (
	"os/exec"
	"syscall"
)

// createNoWindow stops Windows from opening a console window for ccusage
// when the scheduled, windowless ccunifiedw.exe runs it.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// runAs does nothing on Windows: SYSTEM reads each account's files itself.
func runAs(*exec.Cmd, *Account) {}
