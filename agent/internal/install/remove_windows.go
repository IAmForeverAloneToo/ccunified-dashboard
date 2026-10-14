//go:build windows

package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// RemoveProgram takes the folder off the user's PATH and deletes it a few
// seconds after this program exits (a running .exe can't delete itself).
func RemoveProgram(dir string) error {
	if err := removeFromUserPath(dir); err != nil {
		return err
	}
	return removeDirLater(dir, 3)
}

// removeDirLater starts a hidden cmd.exe that waits about delaySeconds, then
// deletes dir, trying once more a little later if something still held a file.
func removeDirLater(dir string, delaySeconds int) error {
	shell := "cmd.exe"
	if root := os.Getenv("SystemRoot"); root != "" {
		shell = filepath.Join(root, "System32", "cmd.exe")
	}
	cmd := exec.Command(shell)
	// cmd.exe doesn't parse the C-style escaping Go uses for arguments
	// (\"), so the command line is passed as is. With /s, cmd strips just
	// the outermost quotes and runs the rest.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       removeDirCmdLine(dir, delaySeconds),
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	cmd.Dir = os.TempDir()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func removeDirCmdLine(dir string, delaySeconds int) string {
	q := `"` + dir + `"`
	wait := func(s int) string { return fmt.Sprintf("ping -n %d 127.0.0.1 >nul", s+1) }
	return fmt.Sprintf(`cmd.exe /d /s /c "%s & rmdir /s /q %s & if exist %s (%s & rmdir /s /q %s)"`,
		wait(delaySeconds), q, q, wait(5), q)
}

func removeFromUserPath(dir string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	current, valType, err := k.GetStringValue("Path")
	if err != nil {
		return nil // no user PATH at all
	}
	var kept []string
	changed := false
	for _, p := range strings.Split(current, ";") {
		if p != "" && SameDir(strings.TrimRight(p, `\`), dir) {
			changed = true
			continue
		}
		if p != "" {
			kept = append(kept, p)
		}
	}
	if !changed {
		return nil
	}
	value := strings.Join(kept, ";")
	if valType == registry.EXPAND_SZ {
		err = k.SetExpandStringValue("Path", value)
	} else {
		err = k.SetStringValue("Path", value)
	}
	if err != nil {
		return err
	}
	broadcastEnvironmentChange()
	return nil
}

// broadcastEnvironmentChange tells Explorer the user's environment changed,
// so new terminals see the updated PATH.
func broadcastEnvironmentChange() {
	user32 := windows.NewLazySystemDLL("user32.dll")
	send := user32.NewProc("SendMessageTimeoutW")
	env, _ := windows.UTF16PtrFromString("Environment")
	const hwndBroadcast, wmSettingChange, abortIfHung = 0xffff, 0x001A, 0x0002
	var result uintptr
	send.Call(hwndBroadcast, wmSettingChange, 0, uintptr(unsafe.Pointer(env)), abortIfHung, 5000, uintptr(unsafe.Pointer(&result)))
}
