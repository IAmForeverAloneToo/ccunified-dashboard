//go:build windows

package config

// On Windows, Chmod only toggles read-only; the user's AppData folder is
// already private to the user, so a failure here is not a problem.
func isUnsupported(error) bool { return true }
