//go:build !windows

package install

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// checkSource refuses to install for every account from a folder that
// isn't root's alone: from a per-user install (~/.local/share/ccunified),
// root would run, and install, a program that account can change.
func checkSource(dir string, names []string) error {
	paths := []string{dir}
	for _, n := range names {
		paths = append(paths, filepath.Join(dir, n))
	}
	for _, p := range paths {
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(st.Uid) != os.Geteuid() || info.Mode().Perm()&0o022 != 0 || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s isn't root's alone (another account owns it, or others may change it), "+
				"so ccunified can't be installed for every account from there. Run install.sh as root instead, "+
				"or copy ccunified and ccusage to %s yourself and run its setup from there", p, SystemDir())
		}
	}
	return nil
}

// secureInstalled makes the install folder, and the named files in it,
// root's (this program's account's), writable by no one else.
func secureInstalled(dir string, names []string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s isn't a folder (it may be a link); remove it and try again", dir)
	}
	uid, gid := os.Geteuid(), os.Getegid()
	if err := os.Lchown(dir, uid, gid); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return err
	}
	for _, n := range names {
		p := filepath.Join(dir, n)
		if fi, err := os.Lstat(p); err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if err := os.Lchown(p, uid, gid); err != nil {
			return err
		}
		if err := os.Chmod(p, fileMode(n)); err != nil {
			return err
		}
	}
	return nil
}
