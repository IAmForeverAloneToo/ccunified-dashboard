//go:build windows

package config

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// checkPrivate checks that only SYSTEM and Administrators have access to
// path, none inherited from above, and returns its owner.
func checkPrivate(t *testing.T, path string) *windows.SID {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, _ := sd.Control()
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Errorf("%s inherits access from its folder: %s", path, sd)
	}
	aces := regexp.MustCompile(`\(([^)]*)\)`).FindAllStringSubmatch(sd.String(), -1)
	if len(aces) == 0 {
		t.Errorf("%s: no access at all: %s", path, sd)
	}
	for _, ace := range aces {
		fields := strings.Split(ace[1], ";")
		if who := fields[len(fields)-1]; fields[0] != "A" || (who != "SY" && who != "BA") {
			t.Errorf("%s: unexpected access %s in %s", path, ace[0], sd)
		}
	}
	owner, _, _ := sd.Owner()
	return owner
}

func TestPrivateDirIsCreatedPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ccunified")
	if err := makePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	checkPrivate(t, dir)
	// Files made in it get the same access.
	if err := writeJSONIn(dir, "system.json", map[string]string{"x": "y"}); err != nil {
		t.Fatal(err)
	}
	sd, _ := windows.GetNamedSecurityInfo(filepath.Join(dir, "system.json"), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if s := sd.String(); strings.Contains(s, ";BU)") || strings.Contains(s, ";AU)") || strings.Contains(s, ";WD)") {
		t.Errorf("system.json is open to others: %s", s)
	}
	// Running again changes nothing.
	if err := makePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
}

func TestPrivateDirRefusesALink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	os.Mkdir(target, 0o755)
	link := filepath.Join(root, "ccunified")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("couldn't make a junction: %v %s", err, out)
	}
	if err := makePrivateDir(link); err == nil || !errors.Is(err, errLink) {
		t.Errorf("a junction was accepted: %v", err)
	}
}

// TestPrivateDirTakesOverSomeoneElsesFolder: a standard account created the
// folder first, and put links in it.
func TestPrivateDirTakesOverSomeoneElsesFolder(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("needs an administrator's elevated window")
	}
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	os.Mkdir(outside, 0o755)
	secret := filepath.Join(outside, "secret.txt")
	os.WriteFile(secret, []byte("not ccunified's"), 0o644)
	before, _ := windows.GetNamedSecurityInfo(secret, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)

	dir := filepath.Join(root, "ccunified")
	alice := filepath.Join(dir, "users", "alice")
	os.MkdirAll(alice, 0o755)
	os.WriteFile(filepath.Join(alice, "config.json"), []byte("{}"), 0o644)
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(dir, "users", "bob"), outside).CombinedOutput(); err != nil {
		t.Skipf("couldn't make a junction: %v %s", err, out)
	}
	if err := os.Link(secret, filepath.Join(dir, "system.json")); err != nil {
		t.Skipf("couldn't make a hard link: %v", err)
	}
	enablePrivileges("SeRestorePrivilege", "SeTakeOwnershipPrivilege")
	users, _ := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, users, nil, nil, nil); err != nil {
		t.Skipf("couldn't give the folder to Users: %v", err)
	}

	if err := makePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	if owner := checkPrivate(t, dir); !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Errorf("owner is %s", owner)
	}
	checkPrivate(t, alice)
	checkPrivate(t, filepath.Join(alice, "config.json"))
	for _, gone := range []string{filepath.Join(dir, "users", "bob"), filepath.Join(dir, "system.json")} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Errorf("the link %s is still there (%v)", gone, err)
		}
	}
	after, err := windows.GetNamedSecurityInfo(secret, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || after.String() != before.String() {
		t.Errorf("a linked file outside was changed: %v, %s -> %s", err, before, after)
	}
}
