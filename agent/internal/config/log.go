package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const maxLogBytes = 1 << 20 // rotate at 1 MiB, keeping one old file

// LogPath is where sync results are recorded.
func LogPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ccunified.log"), nil
}

// Log appends one timestamped line to the log file. Logging never fails a sync.
func Log(format string, args ...any) {
	path, err := LogPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	if info, err := os.Stat(path); err == nil && info.Size() > maxLogBytes {
		os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
