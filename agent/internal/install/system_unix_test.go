//go:build !windows

package install

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestInstallForAllCopiesOnlyFromAFolderRootAloneCanChange(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src")
	os.Mkdir(src, 0o755)
	for name, mode := range map[string]os.FileMode{"ccunified": 0o700, "ccusage": 0o700, "LICENSE": 0o600, "notes.txt": 0o644} {
		os.WriteFile(filepath.Join(src, name), []byte(name), mode)
	}
	target := filepath.Join(root, "opt", "ccunified")
	t.Setenv("CCUNIFIED_SYSTEM_PROGRAM_DIR", target)
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)

	exe, err := InstallForAll(src)
	if err != nil {
		t.Fatal(err)
	}
	if exe != filepath.Join(target, "ccunified") {
		t.Errorf("exe %s", exe)
	}
	// Every account can run it, whatever the copies' modes and the umask.
	for name, want := range map[string]os.FileMode{"ccunified": 0o755, "ccusage": 0o755, "LICENSE": 0o644} {
		if info, err := os.Lstat(filepath.Join(target, name)); err != nil || info.Mode() != want {
			t.Errorf("%s: %v %v", name, info.Mode(), err)
		}
	}
	if _, err := os.Lstat(filepath.Join(target, "notes.txt")); err == nil {
		t.Error("copied a file that isn't the program's")
	}

	// An installed folder others could change is fixed when setup runs from it.
	os.Chmod(target, 0o777)
	os.Chmod(filepath.Join(target, "ccusage"), 0o777)
	if _, err := InstallForAll(target); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(target); info.Mode().Perm() != 0o755 {
		t.Errorf("folder mode %v", info.Mode())
	}
	if info, _ := os.Lstat(filepath.Join(target, "ccusage")); info.Mode().Perm() != 0o755 {
		t.Errorf("ccusage mode %v", info.Mode())
	}

	// A source others may change is refused.
	os.Chmod(filepath.Join(src, "ccusage"), 0o766)
	if _, err := InstallForAll(src); err == nil || !strings.Contains(err.Error(), "isn't root's alone") {
		t.Errorf("a file others may change was installed: %v", err)
	}
	os.Chmod(filepath.Join(src, "ccusage"), 0o755)
	os.Chmod(src, 0o775)
	if _, err := InstallForAll(src); err == nil {
		t.Error("a folder others may change was installed from")
	}
	os.Chmod(src, 0o755)
	if os.Geteuid() == 0 {
		// Another account's install (~alice/.local/share/ccunified).
		os.Chown(filepath.Join(src, "ccunified"), 1234, 1234)
		if _, err := InstallForAll(src); err == nil {
			t.Error("another account's program was installed")
		}
	}
}
