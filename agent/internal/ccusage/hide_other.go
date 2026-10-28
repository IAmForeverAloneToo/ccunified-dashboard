//go:build !windows && !linux

package ccusage

import "os/exec"

func hideWindow(*exec.Cmd) {}

func runAs(*exec.Cmd, *Account) {}
