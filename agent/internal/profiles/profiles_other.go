//go:build !linux && !windows

package profiles

import (
	"errors"
	"os"
)

// List isn't supported here: installing for all users needs Linux or Windows.
func List() ([]Profile, error) {
	return nil, errors.New("installing for all users needs Linux or Windows")
}

func homeEnv(p Profile) []string { return []string{"HOME=" + p.Home, "USER=" + p.Name} }

// Privileged reports whether this program may install for all users: it runs as root.
func Privileged() bool { return os.Geteuid() == 0 }

// SystemAccount reports whether this program runs as root, as deployment
// tools (Ansible, a startup script…) run scripts. Setup then installs for all users.
func SystemAccount() bool { return os.Geteuid() == 0 }
