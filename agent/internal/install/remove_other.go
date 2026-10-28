//go:build !windows

package install

import (
	"os"
	"path/filepath"
)

// RemoveProgram deletes the installed program files and the command link.
func RemoveProgram(dir string) error {
	if target, err := os.Readlink(LinkPath()); err == nil && SameDir(filepath.Dir(target), dir) {
		os.Remove(LinkPath())
	}
	return os.RemoveAll(dir)
}

func removeDir(dir string) error { return os.RemoveAll(dir) }
