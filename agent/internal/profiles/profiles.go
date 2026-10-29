// Package profiles finds the user accounts on this computer, for a
// system-wide install that reads every account's usage.
package profiles

import (
	"net/url"
	"os"
	"strings"
	"unicode"
)

// Profile is a user account with a home folder.
type Profile struct {
	// Name is the login name (the profile folder's name on Windows).
	Name string
	// Home is the account's home folder (its profile folder on Windows).
	Home string
	// UID and GID are the account's ids on Linux (ccusage runs as the
	// account there), and -1 on Windows.
	UID, GID int
	// SID is a Windows account's security id, and Domain and User its
	// domain (the computer's name for a local account) and account name.
	// ccusage logs on as the account with them.
	SID, Domain, User string
}

// keepEnv are variables ccusage may need whoever it reads for: the program
// search path, system folders, language and proxies.
var keepEnv = []string{
	"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP",
	"PROGRAMDATA", "PROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
	"LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE",
	"SSL_CERT_DIR",
}

// proxyEnv are the variables in keepEnv that hold a proxy's address, which
// may include a user name and password.
var proxyEnv = []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"}

// Env is the environment for reading p's usage: the variables in keepEnv
// from base, and p's own home folders, so every tool's logs are looked for
// under p's home (and nothing of the service's own account leaks in).
// Proxy addresses lose their user name and password: those are root's or
// SYSTEM's, not the account's.
func Env(base []string, p Profile) []string {
	own := homeEnv(p)
	var env []string
	for _, kv := range base {
		name, value, _ := strings.Cut(kv, "=")
		if !hasName(keepEnv, name) || hasName(own, name) {
			continue
		}
		if hasName(proxyEnv, name) {
			var ok bool
			if value, ok = withoutPassword(value); !ok {
				continue
			}
			kv = name + "=" + value
		}
		env = append(env, kv)
	}
	return append(env, own...)
}

// hasName reports whether a list of names, or of NAME=value pairs, has a
// name (ignoring case, as Windows does).
func hasName(list []string, name string) bool {
	for _, kv := range list {
		if n, _, _ := strings.Cut(kv, "="); strings.EqualFold(n, name) {
			return true
		}
	}
	return false
}

// withoutPassword removes the user name and password from a proxy's
// address. It reports false for an address it can't read, which is then
// left out.
func withoutPassword(proxy string) (string, bool) {
	if !strings.Contains(proxy, "@") {
		return proxy, true
	}
	raw, bare := proxy, !strings.Contains(proxy, "://")
	if bare {
		raw = "http://" + proxy
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", false
	}
	u.User = nil
	s := u.String()
	if bare {
		s = strings.TrimPrefix(s, "http://")
	}
	return s, true
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
