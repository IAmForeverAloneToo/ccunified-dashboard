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
const (
	privateDirDACL  = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	privateFileDACL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
)

// makePrivateDir creates a folder of a system-wide install with that
// access from the start, so no one else ever holds it, or makes sure the
// one there has it. A link (a junction or symbolic link) is refused. A
// folder someone else created first (a standard account may, in
// ProgramData) is taken over: Administrators become its owner, and
// everything in it gets the same access, links in it removed.
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
	// Administrators may open, and take over, anything.
	enablePrivileges("SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege")
	trusted, err := secure(dir, true, true)
	if err != nil {
		return fmt.Errorf("couldn't make %s private to administrators: %w", dir, err)
	}
	if !trusted {
		if err := secureInside(dir); err != nil {
			return fmt.Errorf("couldn't make what's in %s private to administrators: %w", dir, err)
		}
	}
	return nil
}

var errLink = errors.New("it's a link to somewhere else; remove it and try again")

// secure gives a file or folder the private access, and Administrators as
// owner unless it's SYSTEM or Administrators already (then it reports
// trusted). It never follows a link. With refuse, a link (or a file where a
// folder should be) is an error; without, inside a folder being taken
// over, links are removed, and so are files with other names (hard links):
// setting their access would change the file they're linked to.
func secure(path string, isDir, refuse bool) (trusted bool, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	h, err := windows.CreateFile(p, windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false, err
	}
	defer func() { windows.CloseHandle(h) }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return false, err
	}
	link := info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	dir := info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if refuse {
		if link {
			return false, errLink
		}
		if dir != isDir {
			return false, errors.New("it isn't a folder; remove it and try again")
		}
	} else if link || (!dir && info.NumberOfLinks > 1) {
		windows.CloseHandle(h)
		h = windows.InvalidHandle
		return false, os.Remove(path)
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return false, err
	}
	trusted = owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)
	sddl := privateFileDACL
	if dir {
		sddl = privateDirDACL
	}
	want, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return false, err
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return false, err
	}
	what := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	var newOwner *windows.SID
	if !trusted {
		if newOwner, err = windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid); err != nil {
			return false, err
		}
		what |= windows.OWNER_SECURITY_INFORMATION
	}
	return trusted, windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, what, newOwner, nil, dacl, nil)
}

// secureInside secures everything in a folder that was taken over, and
// removes links in it (they could lead anywhere).
func secureInside(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if _, err := secure(path, e.IsDir(), false); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		// Only real folders are left (links were removed).
		if info, err := os.Lstat(path); err == nil && info.Mode().Type() == os.ModeDir {
			if err := secureInside(path); err != nil {
				return err
			}
		}
	}
	return nil
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
