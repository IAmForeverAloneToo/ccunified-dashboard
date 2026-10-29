//go:build linux

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemDirIsPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "lib", "ccunified")
	t.Setenv("CCUNIFIED_SYSTEM_HOME", dir)
	s := &System{DashboardURL: "https://usage.example.com", EnrollKey: "ccu_e_x", SyncIntervalMinutes: 15}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	if err := PrepareProfileDir("alice"); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{dir, filepath.Join(dir, "users"), ProfileDir("alice")} {
		if info, err := os.Lstat(d); err != nil || info.Mode() != os.ModeDir|0o700 {
			t.Errorf("%s: %v %v", d, info.Mode(), err)
		}
	}

	// A folder opened up is closed again.
	os.Chmod(ProfileDir("alice"), 0o755)
	if err := PrepareProfileDir("alice"); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(ProfileDir("alice")); info.Mode().Perm() != 0o700 {
		t.Errorf("mode %v", info.Mode())
	}
}

func TestSystemDirRefusesLinksAndOthersFolders(t *testing.T) {
	root := t.TempDir()
	elsewhere := filepath.Join(root, "elsewhere")
	os.Mkdir(elsewhere, 0o755)
	dir := filepath.Join(root, "ccunified")
	t.Setenv("CCUNIFIED_SYSTEM_HOME", dir)

	// A link where an account's folder goes.
	if err := SecureSystemDir(); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(dir, "users"), 0o700)
	os.Symlink(elsewhere, ProfileDir("bob"))
	if err := PrepareProfileDir("bob"); err == nil || !strings.Contains(err.Error(), "may be a link") {
		t.Errorf("a link was accepted: %v", err)
	}
	if info, _ := os.Stat(elsewhere); info.Mode().Perm() != 0o755 {
		t.Errorf("the link's target was changed: %v", info.Mode())
	}
	for _, name := range []string{"", ".", "..", "a/b"} {
		if PrepareProfileDir(name) == nil {
			t.Errorf("%q was accepted as a folder name", name)
		}
	}

	// The whole folder belongs to someone else.
	if os.Geteuid() != 0 {
		return
	}
	other := filepath.Join(root, "other")
	os.Mkdir(other, 0o700)
	os.Chown(other, 1234, 1234)
	t.Setenv("CCUNIFIED_SYSTEM_HOME", other)
	if err := SecureSystemDir(); err == nil || !strings.Contains(err.Error(), "belongs to another account") {
		t.Errorf("another account's folder was accepted: %v", err)
	}
}
