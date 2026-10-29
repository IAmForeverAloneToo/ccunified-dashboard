package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
)

func TestOwnSetup(t *testing.T) {
	settings := func(home string) string {
		if runtime.GOOS == "windows" {
			return filepath.Join(home, "AppData", "Roaming", "ccunified")
		}
		return filepath.Join(home, ".config", "ccunified")
	}
	account := func(files ...string) profiles.Profile {
		home := t.TempDir()
		if len(files) > 0 {
			os.MkdirAll(settings(home), 0o700)
		}
		for _, f := range files {
			os.WriteFile(filepath.Join(settings(home), f), []byte("{}"), 0o600)
		}
		return profiles.Profile{Name: "alice", Home: home}
	}
	if ownSetup(account()) {
		t.Error("an account without settings is set up")
	}
	if !ownSetup(account("config.json")) {
		t.Error("an account with its own settings isn't set up")
	}
	if !ownSetup(account("pending.json")) {
		t.Error("an account waiting to join isn't set up")
	}
	if ownSetup(account("state.json")) {
		t.Error("an account with only a sync state is set up")
	}

	// A link isn't followed, to settings that aren't the account's.
	if runtime.GOOS == "windows" {
		return
	}
	other := account("config.json")
	home := t.TempDir()
	os.Symlink(filepath.Join(other.Home, ".config"), filepath.Join(home, ".config"))
	if ownSetup(profiles.Profile{Name: "bob", Home: home}) {
		t.Error("a link was followed")
	}
	home = t.TempDir()
	os.MkdirAll(settings(home), 0o700)
	os.Symlink(filepath.Join(settings(other.Home), "config.json"), filepath.Join(settings(home), "config.json"))
	if ownSetup(profiles.Profile{Name: "carol", Home: home}) {
		t.Error("a linked file was counted")
	}
}
