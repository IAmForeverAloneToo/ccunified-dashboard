package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// staleLockAge is how old a lock can get before it's assumed abandoned
// (a sync takes seconds; ccusage itself is stopped after five minutes).
const staleLockAge = 30 * time.Minute

// ErrBusy means another sync is running on this machine.
var ErrBusy = errors.New("another sync is already running on this machine")

// Lock makes sure only one sync runs at a time. Call the returned function to release it.
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
			fmt.Fprintf(f, "%d %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339))
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		info, statErr := os.Stat(path)
		if statErr == nil && time.Since(info.ModTime()) > staleLockAge {
			os.Remove(path)
			continue
		}
		break
	}
	return nil, ErrBusy
}
