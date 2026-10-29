//go:build windows

package ccusage

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
)

// TestHelperProcess is the program the tests below run as an account: it
// prints which account it runs as.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("CCUSAGE_TEST_HELPER") != "1" {
		return
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(u.User.Sid.String())
	os.Exit(0)
}

func helper(t *testing.T, exe string) *exec.Cmd {
	cmd := exec.Command(exe, "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(), "CCUSAGE_TEST_HELPER=1")
	return cmd
}

func currentSID(t *testing.T) string {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return u.User.Sid.String()
}

func stubLogOn(t *testing.T, f func(user, domain string) (windows.Token, error)) {
	old := s4uLogOn
	s4uLogOn = f
	t.Cleanup(func() { s4uLogOn = old })
}

func TestLogOnAsThisAccountNeedsNoLogon(t *testing.T) {
	stubLogOn(t, func(string, string) (windows.Token, error) {
		t.Error("logged this account on again")
		return 0, errors.New("no")
	})
	a, err := LogOn(Account{UID: -1, GID: -1, SID: currentSID(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cmd := helper(t, os.Args[0])
	runAs(cmd, a)
	if cmd.Err != nil || cmd.SysProcAttr != nil {
		t.Errorf("the command was changed: %v, %+v", cmd.Err, cmd.SysProcAttr)
	}
}

func TestLogOnFailsRatherThanRunningAsSYSTEM(t *testing.T) {
	stubLogOn(t, func(string, string) (windows.Token, error) {
		return 0, errors.New("the domain controller didn't answer")
	})
	other := "S-1-5-21-1111111111-2222222222-3333333333-1001"
	_, err := LogOn(Account{UID: -1, GID: -1, SID: other, Domain: "CORP", User: "alice"})
	if err == nil || !strings.Contains(err.Error(), `couldn't run as CORP\alice: the domain controller didn't answer`) {
		t.Errorf("got %v", err)
	}
	// An account that isn't logged on never runs as this program's account.
	cmd := helper(t, os.Args[0])
	runAs(cmd, &Account{SID: other, User: "alice"})
	if err := cmd.Run(); err == nil || !strings.Contains(err.Error(), "couldn't run as alice") {
		t.Errorf("ran anyway: %v", err)
	}
}

// TestRunsWithTheLogonsToken starts a program with a logon's token, the
// way ccusage starts as another account, with this account's own token (a
// copy of it), as only SYSTEM can log other accounts on.
func TestRunsWithTheLogonsToken(t *testing.T) {
	stubLogOn(t, func(string, string) (windows.Token, error) {
		// A real handle: DuplicateTokenEx refuses the current-token pseudo-handle.
		var self, tok windows.Token
		if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &self); err != nil {
			return 0, err
		}
		defer self.Close()
		err := windows.DuplicateTokenEx(self, windows.MAXIMUM_ALLOWED, nil,
			windows.SecurityImpersonation, windows.TokenPrimary, &tok)
		return tok, err
	})
	other := "S-1-5-21-1111111111-2222222222-3333333333-1001"
	a, err := LogOn(Account{UID: -1, GID: -1, SID: other, Domain: "CORP", User: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cmd := helper(t, os.Args[0])
	runAs(cmd, a)
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.Token == 0 || cmd.SysProcAttr.CreationFlags != detachedProcess || cmd.Dir == "" {
		t.Fatalf("not set up to run as the account: %+v, in %q", cmd.SysProcAttr, cmd.Dir)
	}
	out, err := cmd.Output()
	if errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
		t.Skip("this account may not start programs with another token")
	}
	if err != nil {
		t.Fatal(err)
	}
	if got := string(out); got != currentSID(t) {
		t.Errorf("the program printed %q through its pipe", got)
	}
	a.Close()
	if a.token != 0 {
		t.Error("the logon is still open")
	}
}

// TestLogOnAsAnotherAccount logs a real account on, which needs SYSTEM:
// it runs only as SYSTEM (CI's scheduled task covers it end to end).
func TestLogOnAsAnotherAccount(t *testing.T) {
	if !profiles.SystemAccount() {
		t.Skip("needs SYSTEM")
	}
	accounts, err := profiles.List()
	if err != nil || len(accounts) == 0 {
		t.Skip("no user accounts")
	}
	p := accounts[0]
	a, err := LogOn(Account{UID: -1, GID: -1, SID: p.SID, Domain: p.Domain, User: p.User})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	// The account must be able to run the program.
	dir, err := os.MkdirTemp(os.Getenv("ProgramData"), "ccusage-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	exe := filepath.Join(dir, "helper.exe")
	if err := copyExe(os.Args[0], exe); err != nil {
		t.Fatal(err)
	}
	cmd := helper(t, exe)
	runAs(cmd, a)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := string(out); !strings.EqualFold(got, p.SID) {
		t.Errorf("ran as %q, not %s (%s)", got, p.SID, p.Name)
	}
}

func copyExe(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
