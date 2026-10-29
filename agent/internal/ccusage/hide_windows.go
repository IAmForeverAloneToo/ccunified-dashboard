//go:build windows

package ccusage

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// createNoWindow stops Windows from opening a console window for ccusage
// when the scheduled, windowless ccunifiedw.exe runs it.
const createNoWindow = 0x08000000

// detachedProcess starts ccusage without a console at all. Run as another
// account, a console would need that account to have access to SYSTEM's
// desktop; ccusage only writes to the pipes it's given.
const detachedProcess = 0x00000008

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// runAs runs the command as the account LogOn logged on. If it isn't
// logged on (and isn't this program's own account), the command fails
// rather than running as SYSTEM.
func runAs(cmd *exec.Cmd, a *Account) {
	if a == nil {
		return
	}
	if a.token == 0 {
		sid, err := windows.StringToSid(a.SID)
		if err != nil || !isCurrentUser(sid) {
			cmd.Err = fmt.Errorf("couldn't run as %s: it isn't logged on", a.name())
		}
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess,
		Token:         syscall.Token(a.token),
	}
	// SYSTEM's working folder may be closed to the account.
	dir := os.Getenv("SystemRoot")
	if dir == "" {
		dir = `C:\Windows`
	}
	cmd.Dir = filepath.Clean(dir)
}
