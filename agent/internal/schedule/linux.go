package schedule

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	unitName  = "ccunified-sync"
	cronMark  = "# ccunified-sync"
	lingerYes = "Linger=yes"
)

func (s *Scheduler) unitDir() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "systemd", "user")
	}
	return filepath.Join(s.Home, ".config", "systemd", "user")
}

// systemdQuote quotes a path for ExecStart and escapes systemd's % specifiers.
func systemdQuote(path string) string {
	path = strings.ReplaceAll(path, "%", "%%")
	path = strings.ReplaceAll(path, `\`, `\\`)
	path = strings.ReplaceAll(path, `"`, `\"`)
	return `"` + path + `"`
}

// SystemdUnits returns the service and timer files.
func (s *Scheduler) SystemdUnits(minutes int) (service, timer string) {
	service = fmt.Sprintf(`[Unit]
Description=Upload Claude Code usage to the ccunified dashboard

[Service]
Type=oneshot
ExecStart=%s sync --quiet
Nice=10
`, systemdQuote(s.Exe))
	calendar := fmt.Sprintf("*:0/%d", minutes)
	if minutes == 60 {
		calendar = "hourly"
	}
	timer = fmt.Sprintf(`[Unit]
Description=Upload Claude Code usage every %d minutes

[Timer]
OnCalendar=%s
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
`, minutes, calendar)
	return service, timer
}

func (s *Scheduler) systemdAvailable(ctx context.Context) bool {
	_, err := s.Run(ctx, "", "systemctl", "--user", "show-environment")
	return err == nil
}

func (s *Scheduler) installSystemd(ctx context.Context, minutes int) (string, error) {
	dir := s.unitDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	service, timer := s.SystemdUnits(minutes)
	if err := os.WriteFile(filepath.Join(dir, unitName+".service"), []byte(service), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, unitName+".timer"), []byte(timer), 0o644); err != nil {
		return "", err
	}
	for _, args := range [][]string{
		{"--user", "daemon-reload"},
		{"--user", "enable", "--now", unitName + ".timer"},
		{"--user", "restart", unitName + ".timer"},
	} {
		if out, err := s.Run(ctx, "", "systemctl", args...); err != nil {
			return "", fmt.Errorf("systemctl %s failed: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	return fmt.Sprintf("Background sync %s (systemd user timer %s.timer)", intervalText(minutes), unitName), nil
}

// LingerEnabled reports whether the user's timers keep running after logout.
func (s *Scheduler) LingerEnabled(ctx context.Context) bool {
	out, err := s.Run(ctx, "", "loginctl", "show-user", s.User, "--property=Linger")
	return err == nil && strings.Contains(out, lingerYes)
}

// EnableLinger keeps the user's systemd timers running while logged out.
// It first tries without extra rights, then (if allowed) with sudo, which
// asks for the user's password in the terminal.
func (s *Scheduler) EnableLinger(ctx context.Context, allowSudo bool) error {
	if s.LingerEnabled(ctx) {
		return nil
	}
	if _, err := s.Run(ctx, "", "loginctl", "enable-linger", s.User); err == nil && s.LingerEnabled(ctx) {
		return nil
	}
	if !allowSudo {
		return fmt.Errorf("enabling background syncs while logged out needs admin rights; run: sudo loginctl enable-linger %s", s.User)
	}
	if out, err := s.Run(ctx, "", "sudo", "loginctl", "enable-linger", s.User); err != nil {
		return fmt.Errorf("sudo loginctl enable-linger %s failed: %v: %s", s.User, err, out)
	}
	if !s.LingerEnabled(ctx) {
		return fmt.Errorf("lingering is still off; run: sudo loginctl enable-linger %s", s.User)
	}
	return nil
}

var calendarRe = regexp.MustCompile(`OnCalendar=\*:0/(\d+)|OnCalendar=(hourly)`)

func (s *Scheduler) statusSystemd(ctx context.Context) Status {
	if _, err := s.Run(ctx, "", "systemctl", "--user", "is-enabled", unitName+".timer"); err != nil {
		return Status{}
	}
	st := Status{Installed: true, Kind: "systemd user timer"}
	if b, err := os.ReadFile(filepath.Join(s.unitDir(), unitName+".timer")); err == nil {
		if m := calendarRe.FindStringSubmatch(string(b)); m != nil {
			n := 60
			if m[1] != "" {
				n, _ = strconv.Atoi(m[1])
			}
			st.Detail = intervalText(n)
		}
	}
	if !s.LingerEnabled(ctx) {
		st.Detail += "; pauses while you're logged out (run: sudo loginctl enable-linger " + s.User + ")"
	}
	return st
}

func (s *Scheduler) removeSystemd(ctx context.Context) error {
	s.Run(ctx, "", "systemctl", "--user", "disable", "--now", unitName+".timer")
	for _, f := range []string{unitName + ".timer", unitName + ".service"} {
		if err := os.Remove(filepath.Join(s.unitDir(), f)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	s.Run(ctx, "", "systemctl", "--user", "daemon-reload")
	return nil
}

// ---- cron ----

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// CronLine is the crontab entry for the background sync.
func (s *Scheduler) CronLine(minutes int) string {
	spec := fmt.Sprintf("*/%d * * * *", minutes)
	if minutes == 60 {
		spec = fmt.Sprintf("%d * * * *", rand.IntN(60))
	}
	return fmt.Sprintf("%s %s sync --quiet %s", spec, shellQuote(s.Exe), cronMark)
}

func (s *Scheduler) cronAvailable(ctx context.Context) bool {
	_, err := s.Run(ctx, "", "sh", "-c", "command -v crontab")
	return err == nil
}

func (s *Scheduler) readCrontab(ctx context.Context) ([]string, error) {
	out, err := s.Run(ctx, "", "crontab", "-l")
	if err != nil {
		if strings.Contains(strings.ToLower(out), "no crontab") {
			return nil, nil
		}
		return nil, fmt.Errorf("crontab -l: %v: %s", err, out)
	}
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if l != "" && !strings.HasSuffix(l, cronMark) {
			lines = append(lines, l)
		}
	}
	return lines, nil
}

func (s *Scheduler) writeCrontab(ctx context.Context, lines []string) error {
	text := strings.Join(lines, "\n")
	if text != "" {
		text += "\n"
	}
	if out, err := s.Run(ctx, text, "crontab", "-"); err != nil {
		return fmt.Errorf("crontab: %v: %s", err, out)
	}
	return nil
}

func (s *Scheduler) installCron(ctx context.Context, minutes int) (string, error) {
	lines, err := s.readCrontab(ctx)
	if err != nil {
		return "", err
	}
	if err := s.writeCrontab(ctx, append(lines, s.CronLine(minutes))); err != nil {
		return "", err
	}
	return fmt.Sprintf("Background sync %s (crontab)", intervalText(minutes)), nil
}

func (s *Scheduler) statusCron(ctx context.Context) Status {
	out, err := s.Run(ctx, "", "crontab", "-l")
	if err != nil {
		return Status{}
	}
	for _, l := range strings.Split(out, "\n") {
		if strings.HasSuffix(l, cronMark) {
			detail := ""
			if f := strings.Fields(l); len(f) > 0 && strings.HasPrefix(f[0], "*/") {
				detail = "every " + strings.TrimPrefix(f[0], "*/") + " minutes"
			} else {
				detail = "every 60 minutes"
			}
			return Status{Installed: true, Kind: "cron", Detail: detail}
		}
	}
	return Status{}
}

func (s *Scheduler) removeCron(ctx context.Context) error {
	if !s.statusCron(ctx).Installed {
		return nil
	}
	lines, err := s.readCrontab(ctx)
	if err != nil {
		return err
	}
	return s.writeCrontab(ctx, lines)
}
