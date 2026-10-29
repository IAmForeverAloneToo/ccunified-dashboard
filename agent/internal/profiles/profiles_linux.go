package profiles

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// Where accounts are listed (replaced in tests).
var (
	passwdFile = "/etc/passwd"
	homeRoot   = "/home"
)

// firstUID is the lowest id of a person's account (below are system accounts).
const firstUID = 1000

// List returns the people's accounts: those in /etc/passwd with an id of
// 1000 or more and a login shell, and folders in /home owned by such an id
// (accounts from a directory service, like LDAP, aren't in /etc/passwd).
func List() ([]Profile, error) {
	seen := map[string]bool{}
	var out []Profile
	add := func(p Profile) {
		if seen[p.Home] || !ownedBy(p.Home, p.UID) {
			return
		}
		seen[p.Home] = true
		out = append(out, p)
	}
	if f, err := os.Open(passwdFile); err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			fields := strings.Split(s.Text(), ":")
			if len(fields) < 7 {
				continue
			}
			uid, err1 := strconv.Atoi(fields[2])
			gid, err2 := strconv.Atoi(fields[3])
			shell := filepath.Base(fields[6])
			if err1 != nil || err2 != nil || uid < firstUID || uid >= 60000 ||
				shell == "nologin" || shell == "false" || fields[5] == "" {
				continue
			}
			add(Profile{Name: fields[0], Home: fields[5], UID: uid, GID: gid})
		}
		f.Close()
	}
	entries, _ := os.ReadDir(homeRoot)
	for _, e := range entries {
		home := filepath.Join(homeRoot, e.Name())
		info, err := os.Stat(home)
		if err != nil || !info.IsDir() {
			continue
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Uid < firstUID || st.Uid >= 60000 {
			continue
		}
		add(Profile{Name: e.Name(), Home: home, UID: int(st.Uid), GID: int(st.Gid)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func ownedBy(dir string, uid int) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == uid
}

func homeEnv(p Profile) []string {
	return []string{"HOME=" + p.Home, "USER=" + p.Name, "LOGNAME=" + p.Name}
}

// Privileged reports whether this program may install for all users: it runs as root.
func Privileged() bool { return os.Geteuid() == 0 }

// SystemAccount reports whether this program runs as root, as deployment
// tools (Ansible, a startup script…) run scripts. Setup then installs for all users.
func SystemAccount() bool { return os.Geteuid() == 0 }

// CanRunAs reports whether this program can run ccusage as p: root can run
// it as anyone, any other account only as itself.
func CanRunAs(p Profile) bool { return os.Geteuid() == 0 || os.Geteuid() == p.UID }
