package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/client"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/cloudflare"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/install"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/profiles"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/schedule"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/setup"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

var _ setup.Cloudflare = (*cloudflare.Client)(nil)

func cloudflareFactory(token string) setup.Cloudflare {
	c := cloudflare.New(token)
	c.UserAgent = "ccunified/" + version.Version
	if u := os.Getenv("CCUNIFIED_CLOUDFLARE_API"); u != "" {
		c.BaseURL = u // tests and local rehearsals only
	}
	return c
}

func init() {
	register(&Command{
		Name:    "setup",
		Summary: "Create a new dashboard, or connect this machine to an existing one",
		Usage: `ccunified setup [--no-schedule | --schedule-only]
       ccunified setup --url URL --enroll-key-file FILE [--name NAME] [--interval 15|30|60] [--all-users | --this-user]

With an enrollment key (from the dashboard's Machines page), setup asks no
questions: this machine asks to join, and starts uploading once an admin
approves it on the Approvals page. Run as root or SYSTEM (or with
--all-users), it sets up every user account on the computer, each as its own
machine. The options can also come from the environment: CCUNIFIED_URL,
CCUNIFIED_ENROLL_KEY, CCUNIFIED_NAME, CCUNIFIED_INTERVAL and
CCUNIFIED_ALL_USERS=1.

Keep the key out of the command line, where every account on the computer
can see it while setup runs: put it in CCUNIFIED_ENROLL_KEY, in a file
(--enroll-key-file), or on standard input (--enroll-key -).`,
		Run: runSetup,
	})
	register(&Command{
		Name:    "server",
		Summary: "Update, recover or remove the dashboard on Cloudflare (needs a Cloudflare API token)",
		Usage:   "ccunified server update [--force] | server reset-password [username] | server remove",
		Run:     runServer,
	})
	ScheduleStatus = func() string {
		s, err := schedule.Default()
		if err != nil {
			return err.Error()
		}
		return s.Current(context.Background()).String()
	}
	OnIntervalChange = func(minutes int) error {
		ctx := context.Background()
		s, err := schedule.Default()
		if err != nil || !s.Current(ctx).Installed {
			return nil // nothing scheduled yet; setup will use the new interval
		}
		if _, err := installSchedule(ctx, nil, minutes); err != nil {
			return fmt.Errorf("the interval was saved, but the background schedule couldn't be updated: %w", err)
		}
		return nil
	}
}

// installSchedule sets up the background sync. With a prompter, on Linux it
// also offers to keep the timer running while the user is logged out.
func installSchedule(ctx context.Context, p *prompt.Prompter, minutes int) (string, error) {
	s, err := schedule.Default()
	if err != nil {
		return "", err
	}
	desc, err := s.Install(ctx, minutes)
	if err != nil {
		return "", err
	}
	if p != nil && s.UsesSystemd(ctx) && !s.LingerEnabled(ctx) {
		p.Printf("\nOn Linux, background syncs stop while you're logged out, unless\n")
		p.Printf("\"lingering\" is turned on for your account (this may ask for your sudo password).\n")
		yes, err := p.Confirm("Keep syncing while you're logged out?", true)
		if err != nil {
			return "", err
		}
		if yes {
			if err := s.EnableLinger(ctx, true); err != nil {
				p.Printf("  ! %v\n", err)
			} else {
				desc += ", also while logged out"
			}
		}
	}
	config.Log("schedule: %s", desc)
	return desc, nil
}

func hooks(p *prompt.Prompter) *setup.Hooks {
	return &setup.Hooks{
		InstallSchedule: func(cfg *config.Config) (string, error) {
			return installSchedule(context.Background(), p, cfg.SyncIntervalMinutes)
		},
		Published: func(ctx context.Context, host string) (bool, error) {
			addrs, err := client.LookupPublic(ctx, host)
			return len(addrs) > 0, err
		},
		FirstSync: func(ctx context.Context) (string, error) {
			res, err := RunSync(ctx, true)
			if err != nil {
				return "", err
			}
			if res.DaysWithUsage == 0 {
				return "Connected. No usage on this machine yet; it appears after you use Claude Code (or another tool ccusage reads) here", nil
			}
			return fmt.Sprintf("Uploaded this machine's history (%d day(s) with usage; %s)", res.DaysWithUsage, toolList(res.Tools)), nil
		},
	}
}

func runSetup(ctx context.Context, env *Env, args []string) error {
	fs := newFlags("setup", env)
	scheduleOnly := fs.Bool("schedule-only", false, "only (re)install the background sync")
	noSchedule := fs.Bool("no-schedule", false, "don't set up the background sync (run ccunified sync yourself)")
	url := fs.String("url", os.Getenv("CCUNIFIED_URL"), "the dashboard's address (with --enroll-key)")
	key := fs.String("enroll-key", os.Getenv("CCUNIFIED_ENROLL_KEY"), "join with this enrollment key, asking no questions (- reads it from standard input)")
	keyFile := fs.String("enroll-key-file", "", "join with the enrollment key in this file, asking no questions")
	name := fs.String("name", os.Getenv("CCUNIFIED_NAME"), "this machine's name on the dashboard (default: its hostname)")
	interval := fs.Int("interval", envInt("CCUNIFIED_INTERVAL", 15), "sync every 15, 30 or 60 minutes")
	allUsers := fs.Bool("all-users", os.Getenv("CCUNIFIED_ALL_USERS") == "1", "set up every user account on this computer (needs root or an administrator)")
	thisUser := fs.Bool("this-user", false, "set up only this account, even as root or SYSTEM")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return &UsageError{Msg: "unexpected arguments"}
	}
	if *scheduleOnly && *noSchedule {
		return &UsageError{Msg: "use either --no-schedule or --schedule-only, not both"}
	}
	if *allUsers && *thisUser {
		return &UsageError{Msg: "use either --all-users or --this-user, not both"}
	}
	keyGiven := false
	fs.Visit(func(f *flag.Flag) { keyGiven = keyGiven || f.Name == "enroll-key" })
	k, err := enrollKey(env, *key, keyGiven, *keyFile)
	if err != nil {
		return err
	}
	if k != "" {
		if *url == "" {
			return &UsageError{Msg: "an enrollment key needs the dashboard's address too (--url)"}
		}
		o := setup.EnrollOptions{URL: *url, Key: k, Name: *name, Interval: *interval}
		p := prompt.New(strings.NewReader(""), env.Stdout)
		if *allUsers || (profiles.SystemAccount() && !*thisUser) {
			if !profiles.Privileged() {
				return errors.New("setting up every account needs root (sudo) or an administrator's elevated window")
			}
			return setup.EnrollAllUsers(ctx, p, &setup.Hooks{}, allUsersHooks(*noSchedule), o)
		}
		h := hooks(nil)
		if *noSchedule {
			h.InstallSchedule = nil
		}
		return setup.EnrollUser(ctx, p, h, o)
	}
	p := prompt.New(env.Stdin, env.Stdout)
	if *scheduleOnly {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		desc, err := installSchedule(ctx, p, cfg.SyncIntervalMinutes)
		if err != nil {
			return err
		}
		env.Printf("%s\n", desc)
		return nil
	}
	h := hooks(p)
	if *noSchedule {
		h.InstallSchedule = nil
	}
	return setup.Run(ctx, p, h, cloudflareFactory)
}

// enrollKey is the enrollment key setup joins with: from a file
// (--enroll-key-file), standard input (--enroll-key -), --enroll-key or
// CCUNIFIED_ENROLL_KEY, or "" for none. A key on the command line is shown
// to every account on the computer while setup runs (in the list of running
// programs), so it gets a warning; the environment and files aren't.
func enrollKey(env *Env, key string, onCommandLine bool, file string) (string, error) {
	switch {
	case file != "" && onCommandLine:
		return "", &UsageError{Msg: "use either --enroll-key or --enroll-key-file, not both"}
	case file != "":
		info, err := os.Stat(file)
		if err != nil {
			return "", fmt.Errorf("couldn't read the enrollment key: %w", err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o044 != 0 {
			fmt.Fprintf(env.Stderr, "Warning: other accounts on this computer may read %s; keep enrollment keys private (chmod 600 %s).\n", file, file)
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("couldn't read the enrollment key: %w", err)
		}
		if k := strings.TrimSpace(string(data)); k != "" {
			return k, nil
		}
		return "", fmt.Errorf("%s is empty; put the enrollment key in it", file)
	case key == "-":
		data, err := io.ReadAll(io.LimitReader(env.Stdin, 4096))
		if err != nil {
			return "", fmt.Errorf("couldn't read the enrollment key: %w", err)
		}
		if k := strings.TrimSpace(string(data)); k != "" {
			return k, nil
		}
		return "", errors.New("no enrollment key on standard input")
	case onCommandLine && strings.TrimSpace(key) != "":
		fmt.Fprintf(env.Stderr, "Warning: every account on this computer can see a key on the command line while setup runs.\n"+
			"Pass it in CCUNIFIED_ENROLL_KEY, with --enroll-key-file FILE, or on standard input with --enroll-key - instead.\n")
	}
	return strings.TrimSpace(key), nil
}

func runServer(ctx context.Context, env *Env, args []string) error {
	if len(args) == 0 {
		return &UsageError{Msg: "missing server command"}
	}
	p := prompt.New(env.Stdin, env.Stdout)
	switch args[0] {
	case "update":
		fs := newFlags("server update", env)
		force := fs.Bool("force", false, "update even if the dashboard's version can't be checked")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() > 0 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerUpdate(ctx, p, cloudflareFactory, *force)
	case "reset-password":
		user := ""
		if len(args) == 2 {
			user = args[1]
		} else if len(args) > 2 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerResetPassword(ctx, p, cloudflareFactory, user)
	case "remove":
		if len(args) != 1 {
			return &UsageError{Msg: "unexpected arguments"}
		}
		return setup.ServerRemove(ctx, p, cloudflareFactory)
	}
	return &UsageError{Msg: fmt.Sprintf("unknown server command %q", args[0])}
}

func envInt(name string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return n
	}
	return def
}

// allUsersHooks install the program, schedule and first sync for every account.
func allUsersHooks(noSchedule bool) setup.AllUsersHooks {
	h := setup.AllUsersHooks{
		InstallProgram: func() (string, error) {
			dir, err := install.ExeDir()
			if err != nil {
				return "", err
			}
			return install.InstallForAll(dir)
		},
		InstallSchedule: func(exe string, minutes int) (string, error) {
			desc, err := schedule.SystemDefault(exe).Install(context.Background(), minutes)
			if err == nil {
				config.Log("schedule (all users): %s", desc)
			}
			return desc, err
		},
		SyncAll: func(ctx context.Context, exe string) (string, error) {
			return runProgram(ctx, exe, "sync", "--all-users")
		},
	}
	if noSchedule {
		h.InstallSchedule = nil
	}
	return h
}
