package schedule

import (
	"context"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// fakeCrontab simulates `crontab -l` / `crontab -`.
type fakeCrontab struct {
	content string
	calls   []string
}

func (f *fakeCrontab) run(_ context.Context, stdin, name string, args ...string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	switch {
	case name == "crontab" && len(args) == 1 && args[0] == "-l":
		if f.content == "" {
			return "no crontab for tester", errors.New("exit status 1")
		}
		return strings.TrimRight(f.content, "\n"), nil
	case name == "crontab" && len(args) == 1 && args[0] == "-":
		f.content = stdin
		return "", nil
	case name == "sh":
		return "/usr/bin/crontab", nil
	case name == "systemctl":
		return "", errors.New("Failed to connect to bus")
	}
	return "", errors.New("unexpected command " + name)
}

func TestCronInstallKeepsOtherEntriesAndReplacesOurs(t *testing.T) {
	f := &fakeCrontab{content: "0 3 * * * /usr/local/bin/backup\n"}
	s := &Scheduler{Run: f.run, Exe: "/home/me/my apps/ccunified", User: "me"}
	ctx := context.Background()
	if _, err := s.installCron(ctx, 30); err != nil {
		t.Fatal(err)
	}
	if _, err := s.installCron(ctx, 15); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(f.content), "\n")
	if len(lines) != 2 || lines[0] != "0 3 * * * /usr/local/bin/backup" {
		t.Fatalf("crontab:\n%s", f.content)
	}
	if lines[1] != "*/15 * * * * '/home/me/my apps/ccunified' sync --quiet # ccunified-sync" {
		t.Fatalf("our line: %q", lines[1])
	}
	if st := s.statusCron(ctx); !st.Installed || st.Detail != "every 15 minutes" {
		t.Fatalf("status: %+v", st)
	}
	if err := s.removeCron(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(f.content) != "0 3 * * * /usr/local/bin/backup" {
		t.Fatalf("after remove:\n%s", f.content)
	}
}

func TestCronHourlyAndQuoting(t *testing.T) {
	s := &Scheduler{Exe: "/opt/it's here/ccunified"}
	line := s.CronLine(60)
	if !strings.HasSuffix(line, ` * * * * '/opt/it'\''s here/ccunified' sync --quiet # ccunified-sync`) || strings.HasPrefix(line, "*/") {
		t.Fatalf("%q", line)
	}
}

func TestSystemdUnits(t *testing.T) {
	s := &Scheduler{Exe: "/home/me/100% sure/ccunified"}
	service, timer := s.SystemdUnits(30)
	if !strings.Contains(service, `ExecStart="/home/me/100%% sure/ccunified" sync --quiet`) {
		t.Fatalf("service:\n%s", service)
	}
	for _, want := range []string{"OnCalendar=*:0/30", "Persistent=true", "WantedBy=timers.target"} {
		if !strings.Contains(timer, want) {
			t.Errorf("timer lacks %q:\n%s", want, timer)
		}
	}
	if _, timer := s.SystemdUnits(60); !strings.Contains(timer, "OnCalendar=hourly") {
		t.Errorf("hourly timer:\n%s", timer)
	}
}

func TestSystemdStatusReadsInterval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	s := &Scheduler{Home: home, User: "me", Exe: "/x/ccunified", Run: func(_ context.Context, _ string, name string, args ...string) (string, error) {
		if name == "loginctl" {
			return "Linger=yes", nil
		}
		return "enabled", nil
	}}
	dir := s.unitDir()
	os.MkdirAll(dir, 0o755)
	_, timer := s.SystemdUnits(15)
	os.WriteFile(filepath.Join(dir, unitName+".timer"), []byte(timer), 0o644)
	if st := s.statusSystemd(context.Background()); !st.Installed || st.Detail != "every 15 minutes" {
		t.Fatalf("%+v", st)
	}
}

func TestWindowsTaskXML(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "ccunified.exe")
	os.WriteFile(filepath.Join(dir, "ccunifiedw.exe"), []byte("x"), 0o755)
	s := &Scheduler{Exe: exe, User: "R&D <me>"}
	text := s.WindowsTaskXML(30, time.Date(2026, 10, 14, 9, 30, 0, 0, time.Local), `CORP\R&D <me>`)

	var task struct {
		Interval string `xml:"Triggers>TimeTrigger>Repetition>Interval"`
		Start    string `xml:"Triggers>TimeTrigger>StartBoundary"`
		Logon    string `xml:"Triggers>LogonTrigger>UserId"`
		Command  string `xml:"Actions>Exec>Command"`
		Args     string `xml:"Actions>Exec>Arguments"`
		Catchup  bool   `xml:"Settings>StartWhenAvailable"`
		Multi    string `xml:"Settings>MultipleInstancesPolicy"`
	}
	if err := xml.Unmarshal([]byte(strings.Replace(text, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)), &task); err != nil {
		t.Fatalf("invalid XML: %v\n%s", err, text)
	}
	if task.Interval != "PT30M" || task.Start != "2026-10-14T09:30:00" || task.Logon != `CORP\R&D <me>` ||
		!strings.HasSuffix(task.Command, "ccunifiedw.exe") || task.Args != "sync --quiet" || !task.Catchup || task.Multi != "IgnoreNew" {
		t.Fatalf("task: %+v", task)
	}
	if s.WindowsTaskName() != "ccunified sync (R&D <me>)" {
		t.Fatal(s.WindowsTaskName())
	}

	raw := utf16File("a\nb")
	if raw[0] != 0xFF || raw[1] != 0xFE {
		t.Fatal("missing BOM")
	}
	u := make([]uint16, (len(raw)-2)/2)
	for i := range u {
		u[i] = uint16(raw[2+2*i]) | uint16(raw[3+2*i])<<8
	}
	if string(utf16.Decode(u)) != "a\r\nb" {
		t.Fatal("bad UTF-16")
	}
}

func TestWindowsStatusParsesInterval(t *testing.T) {
	s := &Scheduler{User: "me", Run: func(_ context.Context, _ string, name string, args ...string) (string, error) {
		return "<Task><Triggers><TimeTrigger><Repetition><Interval>PT15M</Interval></Repetition></TimeTrigger></Triggers></Task>", nil
	}}
	if st := s.statusWindows(context.Background()); !st.Installed || st.Detail != "every 15 minutes" {
		t.Fatalf("%+v", st)
	}
}

func TestInvalidInterval(t *testing.T) {
	s := &Scheduler{}
	if _, err := s.Install(context.Background(), 5); err == nil {
		t.Fatal("5-minute interval accepted")
	}
}
