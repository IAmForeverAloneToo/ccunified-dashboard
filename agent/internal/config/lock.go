package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// staleLockAge is how old a lock can get before it's assumed abandoned
// (a sync takes seconds; ccusage itself is stopped after five minutes).
const staleLockAge = 30 * time.Minute

// ErrBusy means another sync is running on this machine.
var ErrBusy = errors.New("another sync is already running on this machine")

// Lock makes sure only one sync runs at a time. Call the returned function to release it.
//
// The lock file holds the process id of its owner. A lock whose process has
// ended, or that is older than 30 minutes, is taken over; releasing a lock
// that was taken over leaves the new owner's alone.
func Lock() (func(), error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "sync.lock")
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			mine := fmt.Sprintf("%d %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano))
			_, werr := f.WriteString(mine)
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				os.Remove(path)
				return nil, werr
			}
			return func() {
				if data, err := os.ReadFile(path); err == nil && string(data) == mine {
					os.Remove(path)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		data, readErr := os.ReadFile(path)
		info, statErr := os.Stat(path)
		if readErr != nil || statErr != nil || !stale(string(data), info.ModTime()) {
			break
		}
		// Remove it only if nobody took it over in the meantime.
		if again, err := os.ReadFile(path); err == nil && string(again) == string(data) {
			os.Remove(path)
		}
	}
	return nil, ErrBusy
}

// stale reports whether a lock with this content, last written at modTime,
// was abandoned.
func stale(content string, modTime time.Time) bool {
	if time.Since(modTime) > staleLockAge {
		return true
	}
	pid, err := strconv.Atoi(strings.Fields(content + " x")[0])
	if err != nil || pid <= 0 {
		// Being written right now, or damaged: wait for the age rule.
		return false
	}
	return !running(pid)
}

// running reports whether a process is still running. On Windows it always
// says yes (only the age rule applies there).
func running(pid int) bool {
	if runtime.GOOS == "windows" || pid == os.Getpid() {
		return true
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
