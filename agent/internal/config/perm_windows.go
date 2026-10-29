//go:build windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows, Chmod only toggles read-only; the user's AppData folder is
// already private to the user, so a failure here is not a problem.
func isUnsupported(error) bool { return true }

// A system-wide install's folders are private to SYSTEM and Administrators,
// inherited by everything in them and nothing inherited from above
// (ProgramData lets every account read, and create folders).
const privateDirDACL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// makePrivateDir creates a folder of a system-wide install with that
// access from the start, so no one else ever holds it, or makes sure the
// one there has it. A folder isn't taken over in place: setting access on a
// folder passes it on to what's inside, which could reach, through hard
// links someone else planted, files outside it. So a link (a junction or
// symbolic link) is refused, and so is a folder whose owner isn't SYSTEM or
// Administrators (a standard account may create folders in ProgramData).
// An administrator's folder without that access is fixed only while empty.
func makePrivateDir(dir string) error {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(privateDirDACL)
	if err != nil {
		return err
	}
	path, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(path, &sa)
	if err == nil || !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	if err := checkPrivateDir(dir, path, sd); err != nil {
		return fmt.Errorf("%s: %w", dir, err)
	}
	return nil
}

var (
	errLink       = errors.New("it's a link to somewhere else; remove it and try again")
	errNotOurs    = errors.New("another account created it, so it can't be trusted; remove it and try again")
	errNotPrivate = errors.New("others may change what's in it; remove it and try again")
	errNotAFolder = errors.New("it isn't a folder; remove it and try again")
)

// checkPrivateDir accepts an existing folder that is SYSTEM's or
// Administrators' and private to them, and makes an administrator's empty
// folder private.
func checkPrivateDir(dir string, path *uint16, want *windows.SECURITY_DESCRIPTOR) error {
	h, err := windows.CreateFile(path, windows.READ_CONTROL|windows.WRITE_DAC|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errLink
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errNotAFolder
	}
	have, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := have.Owner()
	if err != nil {
		return err
	}
	if !owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return errNotOurs
	}
	if isPrivate(have) {
		return nil
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) > 0 {
		return errNotPrivate
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// isPrivate reports whether only SYSTEM and Administrators have access
// (set on it, or inherited from a private folder above).
func isPrivate(sd *windows.SECURITY_DESCRIPTOR) bool {
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return false
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(dacl, i, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			return false
		}
	}
	return true
}

// enablePrivileges turns on privileges this program's account holds, as
// far as it can (an administrator's are off until turned on).
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
