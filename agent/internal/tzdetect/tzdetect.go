// Package tzdetect finds this computer's time zone as an IANA name
// (like "America/Toronto"), for the setup wizard's default.
package tzdetect

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Local returns this computer's IANA time zone, or "UTC" if it can't tell.
func Local() string {
	if tz := os.Getenv("TZ"); tz != "" && valid(strings.TrimPrefix(tz, ":")) {
		return strings.TrimPrefix(tz, ":")
	}
	if tz := platformZone(); valid(tz) {
		return tz
	}
	return "UTC"
}

// FromWindowsID maps a Windows time zone ID ("Eastern Standard Time") to IANA.
func FromWindowsID(id string) string { return windowsToIANA[id] }

// FromLocaltimePath reads an IANA name out of a /etc/localtime symlink target
// such as "/usr/share/zoneinfo/America/Toronto".
func FromLocaltimePath(target string) string {
	target = filepath.ToSlash(target)
	if i := strings.Index(target, "zoneinfo/"); i >= 0 {
		name := target[i+len("zoneinfo/"):]
		name = strings.TrimPrefix(name, "posix/")
		if valid(name) {
			return name
		}
	}
	return ""
}

func valid(tz string) bool {
	if tz == "" || tz == "Local" {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// Valid reports whether tz is an IANA time zone name.
func Valid(tz string) bool { return valid(tz) }

// Search returns known IANA zone names containing every word of query
// (case-insensitive; spaces match underscores), sorted.
func Search(query string) []string {
	words := strings.Fields(strings.ToLower(strings.ReplaceAll(query, "_", " ")))
	seen := map[string]bool{}
	var out []string
	seen["UTC"] = true
	for _, name := range ianaZones {
		seen[name] = true
	}
	for name := range seen {
		hay := strings.ToLower(strings.ReplaceAll(name, "_", " "))
		match := len(words) > 0
		for _, w := range words {
			match = match && strings.Contains(hay, w)
		}
		if match {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}
