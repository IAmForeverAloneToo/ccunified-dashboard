//go:build windows

package install

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// checkSource refuses to install for every account from another account's
// profile (C:\Users\alice\…, or C:\Users\Public): SYSTEM would run, and
// install, a program that account can change. An administrator may install
// from its own profile. Other folders anyone can write to aren't detected:
// install from where install.ps1 puts it, %ProgramFiles%\ccunified.
func checkSource(dir string, _ []string) error {
	if !inside(dir, profilesDir()) || inside(dir, os.Getenv("USERPROFILE")) {
		return nil
	}
	return fmt.Errorf("%s is in a user's profile, which that user can change, so ccunified can't be "+
		"installed for every account from there. Run install.ps1 as SYSTEM or in an elevated window instead, "+
		"or copy ccunified.exe, ccunifiedw.exe and ccusage.exe to %s yourself and run its setup from there", dir, SystemDir())
}

// profilesDir is the folder of the user profiles (C:\Users).
func profilesDir() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		if dir, _, err := k.GetStringValue("ProfilesDirectory"); err == nil {
			if dir, err = registry.ExpandString(dir); err == nil && dir != "" {
				return dir
			}
		}
	}
	return filepath.Join(os.Getenv("SystemDrive")+`\`, "Users")
}

// inside reports whether path is root or in it (ignoring case, as Windows does).
func inside(path, root string) bool {
	if root == "" {
		return false
	}
	p, r := strings.ToLower(filepath.Clean(path)), strings.ToLower(filepath.Clean(root))
	return p == r || strings.HasPrefix(p, strings.TrimSuffix(r, `\`)+`\`)
}

// secureInstalled does nothing on Windows: %ProgramFiles% lets only
// administrators change what's in it.
func secureInstalled(string, []string) error { return nil }
