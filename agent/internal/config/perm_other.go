//go:build !windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func isUnsupported(error) bool { return false }

// makePrivateDir creates a folder of a system-wide install that only root
// can open, or checks the one there: it must be a folder (not a link) that
// belongs to root (this program's account), and its mode is set to 0700.
func makePrivateDir(dir string) error {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	// Opened without following a link, so what's checked is what's fixed.
	f, err := os.OpenFile(dir, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY, 0)
	if err != nil {
		return fmt.Errorf("%s isn't a folder (it may be a link); remove it and try again", dir)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("%s belongs to another account (id %d); remove it and try again", dir, st.Uid)
	}
	if info.Mode().Perm() != 0o700 {
		return f.Chmod(0o700)
	}
	return nil
}
