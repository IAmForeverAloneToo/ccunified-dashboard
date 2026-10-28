package profiles

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const profileList = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`

// List returns the people's accounts: the profiles Windows lists for local
// and domain accounts (security ids S-1-5-21-…) whose folder exists.
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
		out = append(out, Profile{Name: filepath.Base(path), Home: path, UID: -1, GID: -1})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func homeEnv(p Profile) []string {
	drive := filepath.VolumeName(p.Home)
	return []string{
		"USERPROFILE=" + p.Home,
		"HOME=" + p.Home,
		"HOMEDRIVE=" + drive,
		"HOMEPATH=" + strings.TrimPrefix(p.Home, drive),
		"APPDATA=" + filepath.Join(p.Home, "AppData", "Roaming"),
		"LOCALAPPDATA=" + filepath.Join(p.Home, "AppData", "Local"),
		"USERNAME=" + p.Name,
	}
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
