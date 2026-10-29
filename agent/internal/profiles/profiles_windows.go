package profiles

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const profileList = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`

// List returns the people's accounts: the profiles Windows lists for local
// and domain accounts (security ids S-1-5-21-…) whose folder exists, with
// each account's domain and name. Profiles left behind by deleted accounts
// are skipped; a domain account Windows can't look up right now (no domain
// controller answers) is kept without them.
func List() ([]Profile, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, profileList, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil, err
	}
	defer k.Close()
	sids, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, err
	}
	var out []Profile
	for _, sid := range sids {
		if !strings.HasPrefix(sid, "S-1-5-21-") {
			continue
		}
		sk, err := registry.OpenKey(k, sid, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		path, _, err := sk.GetStringValue("ProfileImagePath")
		sk.Close()
		if err != nil {
			continue
		}
		path, _ = registry.ExpandString(path)
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			continue
		}
		p := Profile{Name: filepath.Base(path), Home: path, UID: -1, GID: -1, SID: sid}
		if s, err := windows.StringToSid(sid); err == nil {
			user, domain, _, err := s.LookupAccount("")
			if errors.Is(err, windows.ERROR_NONE_MAPPED) {
				continue
			}
			p.User, p.Domain = user, domain
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func homeEnv(p Profile) []string {
	drive := filepath.VolumeName(p.Home)
	local := filepath.Join(p.Home, "AppData", "Local")
	user := p.User
	if user == "" {
		user = p.Name
	}
	env := []string{
		"USERPROFILE=" + p.Home,
		"HOME=" + p.Home,
		"HOMEDRIVE=" + drive,
		"HOMEPATH=" + strings.TrimPrefix(p.Home, drive),
		"APPDATA=" + filepath.Join(p.Home, "AppData", "Roaming"),
		"LOCALAPPDATA=" + local,
		"USERNAME=" + user,
		// ccusage runs as the account: its own temporary and cache folders.
		"TEMP=" + filepath.Join(local, "Temp"),
		"TMP=" + filepath.Join(local, "Temp"),
		"XDG_CACHE_HOME=" + filepath.Join(p.Home, ".cache"),
	}
	if p.Domain != "" {
		env = append(env, "USERDOMAIN="+p.Domain)
	}
	return env
}

// Privileged reports whether this program may install for all users: it
// runs as SYSTEM or as an administrator with full rights (an elevated window).
func Privileged() bool {
	return windows.GetCurrentProcessToken().IsElevated() || SystemAccount()
}

// SystemAccount reports whether this program runs as SYSTEM, as deployment
// tools (Intune, Group Policy…) run scripts. Setup then installs for all users.
func SystemAccount() bool {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && u.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
}

// CanRunAs reports whether this program can run ccusage as p: SYSTEM logs
// any account on without its password; an administrator runs it only as
// itself.
func CanRunAs(p Profile) bool {
	if SystemAccount() {
		return true
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && strings.EqualFold(u.User.Sid.String(), p.SID)
}
