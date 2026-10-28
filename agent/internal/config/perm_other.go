//go:build !windows

package config

import "os"

func isUnsupported(error) bool { return false }

// restrictToAdmins makes a folder private to root (its mode already is, as
// created with 0700; this fixes one created otherwise).
func restrictToAdmins(dir string) error { return os.Chmod(dir, 0o700) }
