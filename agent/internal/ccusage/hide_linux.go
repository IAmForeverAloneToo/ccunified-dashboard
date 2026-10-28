package ccusage

import (
	"os"
	"os/exec"
	"syscall"
)

func hideWindow(*exec.Cmd) {}

// runAs runs the command as another account (only root can).
func runAs(cmd *exec.Cmd, a *Account) {
	if a == nil || (a.UID == os.Geteuid() && a.GID == os.Getegid()) {
		return
	}
	// Root's working folder may be closed to the account.
	cmd.Dir = "/"
	// No supplementary groups: none of root's carry over.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: uint32(a.UID), Gid: uint32(a.GID)},
	}
}
