//go:build windows

package install

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The folder name has a space and an "&", which cmd.exe treats specially
// unless the command line is quoted correctly.
func TestRemoveDirLaterDeletesTheFolder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ccunified test & co")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"ccunified.exe", filepath.Join("sub", "notes.txt")} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeDirLater(dir, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the folder was removed immediately instead of after the delay: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("%s still exists 30 seconds later", dir)
}
