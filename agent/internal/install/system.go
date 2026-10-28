package install

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// SystemDir is where a system-wide install keeps the program, readable by
// every account (ccusage runs as each account on Linux):
//
//	Windows: %ProgramFiles%\ccunified
//	Linux:   /opt/ccunified (with the command in /usr/local/bin)
func SystemDir() string {
	if d := os.Getenv("CCUNIFIED_SYSTEM_PROGRAM_DIR"); d != "" {
		return d // tests
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("ProgramFiles")
		if base == "" {
			base = `C:\Program Files`
		}
		return filepath.Join(base, "ccunified")
	}
	return "/opt/ccunified"
}

// SystemLinkPath is the command link a system-wide install creates on Linux.
const SystemLinkPath = "/usr/local/bin/ccunified"

// programFile reports whether a file in the install folder belongs to the program.
func programFile(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, "ccunified") || strings.HasPrefix(n, "ccusage") || strings.HasPrefix(n, "license")
}

// InstallForAll copies the program from dir into SystemDir (unless it's
// already there) and returns the path of ccunified in it. On Linux it also
// links the command into /usr/local/bin.
func InstallForAll(dir string) (string, error) {
	target := SystemDir()
	exe := filepath.Join(target, "ccunified")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	if !SameDir(dir, target) {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return "", err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return "", err
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || !programFile(e.Name()) || strings.HasSuffix(e.Name(), ".old") {
				continue
			}
			if err := copyFile(filepath.Join(dir, e.Name()), filepath.Join(target, e.Name())); err != nil {
				return "", fmt.Errorf("couldn't copy %s to %s: %w", e.Name(), target, err)
			}
		}
	}
	if runtime.GOOS == "linux" && os.Getenv("CCUNIFIED_SYSTEM_PROGRAM_DIR") == "" {
		os.MkdirAll(filepath.Dir(SystemLinkPath), 0o755)
		os.Remove(SystemLinkPath)
		if err := os.Symlink(exe, SystemLinkPath); err != nil {
			return "", fmt.Errorf("couldn't link %s: %w", SystemLinkPath, err)
		}
	}
	return exe, nil
}

// copyFile copies a file through a temporary name, so a running copy of the
// target is replaced, not overwritten (on Windows it's renamed to *.old).
func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := to + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm()|0o444)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if _, err := os.Stat(to); err == nil && runtime.GOOS == "windows" {
		os.Remove(to + ".old")
		if err := os.Rename(to, to+".old"); err != nil {
			return err
		}
	}
	return os.Rename(tmp, to)
}

// RemoveForAll deletes a system-wide install's program and command link.
func RemoveForAll() error {
	if target, err := os.Readlink(SystemLinkPath); err == nil && SameDir(filepath.Dir(target), SystemDir()) {
		os.Remove(SystemLinkPath)
	}
	return removeDir(SystemDir())
}
