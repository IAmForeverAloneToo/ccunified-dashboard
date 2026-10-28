package schedule

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// WindowsTaskName is per user, so several people on one PC don't collide.
func (s *Scheduler) WindowsTaskName() string {
	if s.System {
		return "ccunified sync (all users)"
	}
	return fmt.Sprintf("ccunified sync (%s)", s.User)
}

// windowlessExe is ccunifiedw.exe next to ccunified.exe: the same program
// built as a Windows GUI app, so running it never opens a console window.
func (s *Scheduler) windowlessExe() string {
	w := filepath.Join(filepath.Dir(s.Exe), "ccunifiedw.exe")
	if _, err := os.Stat(w); err == nil {
		return w
	}
	return s.Exe
}

func xmlEscape(v string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(v))
	return b.String()
}

// WindowsTaskXML is the Task Scheduler definition for the background sync.
// A user's sync also runs when they log on; a system-wide one runs as
// SYSTEM, also when the computer starts.
func (s *Scheduler) WindowsTaskXML(minutes int, now time.Time, domainUser string) string {
	extraTrigger := fmt.Sprintf(`<LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%s</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>`, xmlEscape(domainUser))
	principal := `<LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>`
	description := "Uploads this computer's Claude Code usage to your ccunified dashboard."
	if s.System {
		extraTrigger = `<BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT5M</Delay>
    </BootTrigger>`
		principal = `<UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>`
		description = "Uploads every account's AI coding tool usage to the ccunified dashboard."
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>%s</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT%dM</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>%s</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    %s
  </Triggers>
  <Principals>
    <Principal id="Author">
      %s
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%s</Command>
      <Arguments>%s</Arguments>
    </Exec>
  </Actions>
</Task>
`, description, minutes, now.Format("2006-01-02T15:04:05"), extraTrigger, principal,
		xmlEscape(s.windowlessExe()), s.syncArgs())
}

// utf16File encodes text as UTF-16LE with a byte-order mark, the encoding
// schtasks expects for task XML.
func utf16File(text string) []byte {
	units := utf16.Encode([]rune(strings.ReplaceAll(text, "\n", "\r\n")))
	out := []byte{0xFF, 0xFE}
	for _, u := range units {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func (s *Scheduler) installWindows(ctx context.Context, minutes int) (string, error) {
	domainUser := s.User
	if d := os.Getenv("USERDOMAIN"); d != "" {
		domainUser = d + `\` + s.User
	}
	dir, err := os.MkdirTemp("", "ccunified-task")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "task.xml")
	if err := os.WriteFile(path, utf16File(s.WindowsTaskXML(minutes, time.Now(), domainUser)), 0o600); err != nil {
		return "", err
	}
	if out, err := s.Run(ctx, "", "schtasks", "/Create", "/TN", s.WindowsTaskName(), "/XML", path, "/F"); err != nil {
		return "", fmt.Errorf("Task Scheduler refused the task: %v: %s", err, out)
	}
	return fmt.Sprintf("Background sync %s (Task Scheduler: %q)", intervalText(minutes), s.WindowsTaskName()), nil
}

var intervalRe = regexp.MustCompile(`<Interval>PT(\d+)M</Interval>`)

func (s *Scheduler) statusWindows(ctx context.Context) Status {
	out, err := s.Run(ctx, "", "schtasks", "/Query", "/TN", s.WindowsTaskName(), "/XML", "ONE")
	if err != nil {
		return Status{}
	}
	st := Status{Installed: true, Kind: "Task Scheduler"}
	if m := intervalRe.FindStringSubmatch(out); m != nil {
		n, _ := strconv.Atoi(m[1])
		st.Detail = intervalText(n)
	}
	return st
}

func (s *Scheduler) removeWindows(ctx context.Context) error {
	if !s.statusWindows(ctx).Installed {
		return nil
	}
	if out, err := s.Run(ctx, "", "schtasks", "/Delete", "/TN", s.WindowsTaskName(), "/F"); err != nil {
		return fmt.Errorf("couldn't remove the scheduled task: %v: %s", err, out)
	}
	return nil
}

// RunNowWindows starts the scheduled task immediately (tests, diagnostics).
func (s *Scheduler) RunNowWindows(ctx context.Context) error {
	if out, err := s.Run(ctx, "", "schtasks", "/Run", "/TN", s.WindowsTaskName()); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}
