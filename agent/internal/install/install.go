// Package install knows where ccunified is installed and how to remove it.
package install

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DefaultDir is where the installers put ccunified:
//
//	Windows: %LOCALAPPDATA%\Programs\ccunified
//	Linux:   ~/.local/share/ccunified (or $XDG_DATA_HOME/ccunified)
func DefaultDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "ccunified")
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "ccunified")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "ccunified")
}

// ExeDir is the folder of the running program, with links resolved.
func ExeDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

// SameDir compares folders the way the OS does (case-insensitive on Windows).
func SameDir(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// LinkPath is the command-line link the Linux installer creates.
func LinkPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "bin", "ccunified")
}
