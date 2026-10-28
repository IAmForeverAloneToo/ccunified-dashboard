package schedule

import (
	"strings"
	"testing"
	"time"
)

func TestSystemWideSchedules(t *testing.T) {
	s := &Scheduler{Exe: "/opt/ccunified/ccunified", System: true}
	service, _ := s.SystemdUnits(30)
	if !strings.Contains(service, `ExecStart="/opt/ccunified/ccunified" sync --all-users --quiet`) {
		t.Errorf("service:\n%s", service)
	}
	if line := s.CronLine(15); line != `*/15 * * * * root '/opt/ccunified/ccunified' sync --all-users --quiet # ccunified-sync` {
		t.Errorf("cron line: %s", line)
	}
	if s.WindowsTaskName() != "ccunified sync (all users)" {
		t.Errorf("task name: %s", s.WindowsTaskName())
	}
	xml := s.WindowsTaskXML(60, time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC), "")
	for _, want := range []string{"<UserId>S-1-5-18</UserId>", "<BootTrigger>", "<Arguments>sync --all-users --quiet</Arguments>", "<Interval>PT60M</Interval>"} {
		if !strings.Contains(xml, want) {
			t.Errorf("task XML lacks %s", want)
		}
	}
	if strings.Contains(xml, "LogonTrigger") || strings.Contains(xml, "InteractiveToken") {
		t.Error("a SYSTEM task shouldn't wait for someone to log on")
	}
}
