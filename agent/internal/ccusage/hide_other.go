//go:build !windows

package ccusage

import "os/exec"

func hideWindow(*exec.Cmd) {}
