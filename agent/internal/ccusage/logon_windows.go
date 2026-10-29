//go:build windows

package ccusage

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A system-wide install runs as SYSTEM and reads each account's usage by
// running ccusage as that account, as on Linux. SYSTEM gets a logon for the
// account without its password (an "S4U" logon, as Task Scheduler uses for
// tasks that store no password): MSV1_0 for a local account, Kerberos for a
// domain account (which needs a domain controller).

var (
	secur32                            = windows.NewLazySystemDLL("secur32.dll")
	procLsaRegisterLogonProcess        = secur32.NewProc("LsaRegisterLogonProcess")
	procLsaLookupAuthenticationPackage = secur32.NewProc("LsaLookupAuthenticationPackage")
	procLsaLogonUser                   = secur32.NewProc("LsaLogonUser")
	procLsaFreeReturnBuffer            = secur32.NewProc("LsaFreeReturnBuffer")
	procLsaDeregisterLogonProcess      = secur32.NewProc("LsaDeregisterLogonProcess")
	procAllocateLocallyUniqueId        = windows.NewLazySystemDLL("advapi32.dll").NewProc("AllocateLocallyUniqueId")
)

// s4uLogOn logs an account on without its password and returns a token
// to start programs with (replaced in tests).
var s4uLogOn = lsaS4ULogOn

// LogOn prepares running ccusage as a Windows account. Run as SYSTEM, it
// logs the account on; run as the account itself (an administrator setting
// the computer up from its own window), nothing is needed. If the logon
// fails, so does LogOn: ccusage never reads an account's files as SYSTEM.
// Close the account when done.
func LogOn(a Account) (*Account, error) {
	if a.SID == "" {
		return nil, fmt.Errorf("couldn't run as %s: its security id is unknown", a.name())
	}
	sid, err := windows.StringToSid(a.SID)
	if err != nil {
		return nil, fmt.Errorf("couldn't run as %s: %w", a.name(), err)
	}
	if isCurrentUser(sid) {
		return &a, nil
	}
	if a.User == "" || a.Domain == "" {
		if a.User, a.Domain, _, err = sid.LookupAccount(""); err != nil {
			return nil, fmt.Errorf("couldn't run as %s: Windows couldn't look the account up: %w", a.name(), err)
		}
	}
	token, err := s4uLogOn(a.User, a.Domain)
	if err != nil {
		return nil, fmt.Errorf("couldn't run as %s: %w", a.name(), err)
	}
	a.token = uintptr(token)
	return &a, nil
}

// Close ends the account's logon.
func (a *Account) Close() {
	if a != nil && a.token != 0 {
		windows.CloseHandle(windows.Handle(a.token))
		a.token = 0
	}
}

func (a *Account) name() string {
	switch {
	case a.User != "" && a.Domain != "":
		return a.Domain + `\` + a.User
	case a.User != "":
		return a.User
	}
	return a.SID
}

// isCurrentUser reports whether this program runs as the account sid.
func isCurrentUser(sid *windows.SID) bool {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && u.User.Sid.Equals(sid)
}

// tokenSource is TOKEN_SOURCE: who made a logon.
type tokenSource struct {
	Name [8]byte
	ID   windows.LUID
}

const logonNetwork = 3 // Network, the usual logon type for S4U

// lsaS4ULogOn logs an account on through LSA, which needs SYSTEM (the Tcb
// privilege), and returns a primary token for it.
func lsaS4ULogOn(user, domain string) (windows.Token, error) {
	for _, p := range []*windows.LazyProc{procLsaRegisterLogonProcess, procLsaLookupAuthenticationPackage,
		procLsaLogonUser, procLsaFreeReturnBuffer, procLsaDeregisterLogonProcess} {
		if err := p.Find(); err != nil {
			return 0, err
		}
	}
	enablePrivileges("SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege")
	// (Pointers are converted in each Call's arguments, which keeps what
	// they point to in place during the call.)
	var lsa windows.Handle
	var mode uint32
	r, _, _ := procLsaRegisterLogonProcess.Call(uintptr(unsafe.Pointer(lsaString("ccunified"))),
		uintptr(unsafe.Pointer(&lsa)), uintptr(unsafe.Pointer(&mode)))
	if err := ntError(r); err != nil {
		if errors.Is(err, windows.STATUS_PRIVILEGE_NOT_HELD) || errors.Is(err, windows.STATUS_PORT_CONNECTION_REFUSED) {
			return 0, fmt.Errorf("only SYSTEM can run programs as another account (%w)", err)
		}
		return 0, fmt.Errorf("couldn't connect to Windows' logon service: %w", err)
	}
	defer procLsaDeregisterLogonProcess.Call(uintptr(lsa))

	pkgName, name, realm := "MICROSOFT_AUTHENTICATION_PACKAGE_V1_0", user, domain
	if computer, _ := windows.ComputerName(); !strings.EqualFold(domain, computer) {
		var err error
		pkgName, realm = "Kerberos", ""
		if name, err = principalName(user, domain); err != nil {
			return 0, fmt.Errorf("couldn't find the domain account (can this computer reach a domain controller?): %w", err)
		}
	}
	var pkg uint32
	r, _, _ = procLsaLookupAuthenticationPackage.Call(uintptr(lsa),
		uintptr(unsafe.Pointer(lsaString(pkgName))), uintptr(unsafe.Pointer(&pkg)))
	if err := ntError(r); err != nil {
		return 0, fmt.Errorf("couldn't find Windows' %s logon: %w", pkgName, err)
	}

	req := s4uLogonBuffer(name, realm)
	var source tokenSource
	copy(source.Name[:], "ccunifie")
	if procAllocateLocallyUniqueId.Find() == nil {
		procAllocateLocallyUniqueId.Call(uintptr(unsafe.Pointer(&source.ID)))
	}
	var (
		profile    uintptr
		profileLen uint32
		logonID    windows.LUID
		token      windows.Token
		quotas     [8]uint64 // QUOTA_LIMITS, with room to spare
		subStatus  windows.NTStatus
	)
	r, _, _ = procLsaLogonUser.Call(uintptr(lsa), uintptr(unsafe.Pointer(lsaString("ccunified"))),
		logonNetwork, uintptr(pkg), uintptr(unsafe.Pointer(&req[0])), uintptr(len(req)),
		0, uintptr(unsafe.Pointer(&source)), uintptr(unsafe.Pointer(&profile)),
		uintptr(unsafe.Pointer(&profileLen)), uintptr(unsafe.Pointer(&logonID)),
		uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&quotas)), uintptr(unsafe.Pointer(&subStatus)))
	runtime.KeepAlive(req)
	err := ntError(r)
	if profile != 0 {
		procLsaFreeReturnBuffer.Call(profile)
	}
	if err != nil {
		if subStatus != 0 {
			err = fmt.Errorf("%w (%w)", err, subStatus)
		}
		return 0, fmt.Errorf("Windows didn't log the account on: %w", err)
	}
	defer token.Close()
	var primary windows.Token
	if err := windows.DuplicateTokenEx(token, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		return 0, fmt.Errorf("couldn't use the account's logon: %w", err)
	}
	return primary, nil
}

// principalName is a domain account's user principal name (alice@corp.example).
func principalName(user, domain string) (string, error) {
	sam := domain + `\` + user
	if upn, err := windows.TranslateAccountName(sam, windows.NameSamCompatible, windows.NameUserPrincipal, 64); err == nil && upn != "" {
		return upn, nil
	}
	// Accounts without one set have the implied user@dns-domain.
	canonical, err := windows.TranslateAccountName(sam, windows.NameSamCompatible, windows.NameCanonical, 64)
	if err != nil {
		return "", err
	}
	dns, _, _ := strings.Cut(canonical, "/")
	return user + "@" + dns, nil
}

// ntError is the error of an LSA function's NTSTATUS, if it is one.
func ntError(r uintptr) error {
	if int32(r) < 0 {
		return windows.NTStatus(uint32(r))
	}
	return nil
}

// lsaString is LSA_STRING (8-bit characters).
func lsaString(s string) *windows.NTString {
	b := append([]byte(s), 0)
	return &windows.NTString{Length: uint16(len(s)), MaximumLength: uint16(len(b)), Buffer: &b[0]}
}

// enablePrivileges turns on privileges this program's account holds, as
// far as it can (SYSTEM holds the ones a logon and starting a program as
// another account need, but not all are on).
func enablePrivileges(names ...string) {
	var t windows.Token
	if windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &t) != nil {
		return
	}
	defer t.Close()
	for _, n := range names {
		var luid windows.LUID
		if windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(n), &luid) != nil {
			continue
		}
		tp := windows.Tokenprivileges{PrivilegeCount: 1}
		tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
		windows.AdjustTokenPrivileges(t, false, &tp, 0, nil, nil)
	}
}
