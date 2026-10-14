//go:build windows

package install

import "testing"

func TestRemoveDirCmdLine(t *testing.T) {
	got := removeDirCmdLine(`C:\Users\A B\AppData\Local\Programs\ccunified`, 3)
	want := `cmd.exe /d /s /c "ping -n 4 127.0.0.1 >nul & rmdir /s /q "C:\Users\A B\AppData\Local\Programs\ccunified" & ` +
		`if exist "C:\Users\A B\AppData\Local\Programs\ccunified" (ping -n 6 127.0.0.1 >nul & rmdir /s /q "C:\Users\A B\AppData\Local\Programs\ccunified")"`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}
