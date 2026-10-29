package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEnrollKeyStaysOffTheCommandLine(t *testing.T) {
	var stderr bytes.Buffer
	env := &Env{Stdin: strings.NewReader("  ccu_e_fromstdin\n"), Stdout: &bytes.Buffer{}, Stderr: &stderr}

	// From the environment: no warning.
	if k, err := enrollKey(env, " ccu_e_env ", false, ""); err != nil || k != "ccu_e_env" || stderr.Len() > 0 {
		t.Errorf("environment: %q %v %q", k, err, stderr.String())
	}
	// From standard input.
	if k, err := enrollKey(env, "-", true, ""); err != nil || k != "ccu_e_fromstdin" || stderr.Len() > 0 {
		t.Errorf("standard input: %q %v %q", k, err, stderr.String())
	}
	env.Stdin = strings.NewReader("\n")
	if _, err := enrollKey(env, "-", true, ""); err == nil {
		t.Error("an empty standard input was accepted")
	}
	// From a file only this account reads.
	file := filepath.Join(t.TempDir(), "key")
	os.WriteFile(file, []byte("ccu_e_fromfile\r\n"), 0o600)
	if k, err := enrollKey(env, "", false, file); err != nil || k != "ccu_e_fromfile" || stderr.Len() > 0 {
		t.Errorf("file: %q %v %q", k, err, stderr.String())
	}
	if _, err := enrollKey(env, "ccu_e_x", true, file); err == nil {
		t.Error("both a key and a key file were accepted")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(file, 0o644)
		if k, err := enrollKey(env, "", false, file); err != nil || k != "ccu_e_fromfile" || !strings.Contains(stderr.String(), "may read") {
			t.Errorf("readable file: %q %v %q", k, err, stderr.String())
		}
		stderr.Reset()
	}
	// On the command line: a warning.
	if k, err := enrollKey(env, "ccu_e_typed", true, ""); err != nil || k != "ccu_e_typed" || !strings.Contains(stderr.String(), "Warning: every account") {
		t.Errorf("command line: %q %v %q", k, err, stderr.String())
	}
}
