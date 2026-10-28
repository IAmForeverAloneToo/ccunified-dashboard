// Package profiles finds the user accounts on this computer, for a
// system-wide install that reads every account's usage.
package profiles

import (
	"os"
	"strings"
	"unicode"
)

// Profile is a user account with a home folder.
type Profile struct {
	// Name is the login name.
	Name string
	// Home is the account's home folder (its profile folder on Windows).
	Home string
	// UID and GID are the account's ids on Linux (ccusage runs as the
	// account there), and -1 on Windows.
	UID, GID int
}

// keepEnv are variables ccusage may need whoever it reads for: the program
// search path, system folders, language and proxies.
var keepEnv = []string{
	"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP",
	"PROGRAMDATA", "PROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
	"LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE",
	"SSL_CERT_DIR",
}

// Env is the environment for reading p's usage: the variables in keepEnv
// from base, and p's own home folders, so every tool's logs are looked for
// under p's home (and nothing of the service's own account leaks in).
func Env(base []string, p Profile) []string {
	var env []string
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		for _, keep := range keepEnv {
			if strings.EqualFold(name, keep) {
				env = append(env, kv)
				break
			}
		}
	}
	return append(env, homeEnv(p)...)
}

// MachineName is how an account's machine is named on the dashboard:
// "HOST (user)", at most 64 characters.
func MachineName(host string, p Profile) string {
	if host == "" {
		host = "computer"
	}
	user := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, p.Name)
	name := host + " (" + user + ")"
	if r := []rune(name); len(r) > 64 {
		name = string(r[:63]) + ")"
	}
	return name
}

// Hostname is this computer's name, for MachineName.
func Hostname() string {
	h, _ := os.Hostname()
	return h
}
