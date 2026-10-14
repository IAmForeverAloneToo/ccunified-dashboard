//go:build !windows

package tzdetect

import (
	"os"
	"strings"
)

func platformZone() string {
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if tz := FromLocaltimePath(target); tz != "" {
			return tz
		}
	}
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		return strings.TrimSpace(string(data))
	}
	return ""
}
