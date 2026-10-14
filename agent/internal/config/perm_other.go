//go:build !windows

package config

func isUnsupported(error) bool { return false }
