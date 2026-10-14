//go:build !windows

package schedule

import (
	"os"
	"os/exec"
	"os/user"
)

func currentUser() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return os.Getenv("USER")
}

func hide(*exec.Cmd) {}
