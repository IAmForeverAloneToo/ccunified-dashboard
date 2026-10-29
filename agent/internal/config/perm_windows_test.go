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

// TestPrivateDirRefusesSomeoneElsesFolder: a standard account created the
// folder first, and put links in it. It's refused, and nothing it leads to
// is changed.
func TestPrivateDirRefusesSomeoneElsesFolder(t *testing.T) {
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
	os.MkdirAll(filepath.Join(dir, "users"), 0o755)
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

	if err := makePrivateDir(dir); err == nil || !errors.Is(err, errNotOurs) {
		t.Errorf("someone else's folder was accepted: %v", err)
	}
	after, err := windows.GetNamedSecurityInfo(secret, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || after.String() != before.String() {
		t.Errorf("a linked file outside was changed: %v, %s -> %s", err, before, after)
	}
}

// An administrator's folder that isn't private is fixed while empty, and
// refused once something is in it.
func TestPrivateDirFixesOnlyAnEmptyFolder(t *testing.T) {
	root := t.TempDir()
	empty := filepath.Join(root, "empty")
	os.Mkdir(empty, 0o755)
	if err := makePrivateDir(empty); err != nil {
		t.Fatal(err)
	}
	checkPrivate(t, empty)

	full := filepath.Join(root, "full")
	os.Mkdir(full, 0o755)
	os.WriteFile(filepath.Join(full, "system.json"), []byte("{}"), 0o644)
	if err := makePrivateDir(full); err == nil || !errors.Is(err, errNotPrivate) {
		t.Errorf("a folder others may change was accepted: %v", err)
	}
}
