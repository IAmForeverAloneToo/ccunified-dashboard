package setup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/config"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/login"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server/d1test"
)

type fakeCF struct {
	t             *testing.T
	goodToken     string
	token         string
	existingDB    bool
	takenHosts    map[string]bool
	db            *d1test.DB
	uploaded      []byte
	uploadedDB    string
	workersDevOff bool
	domain        string
	attachErr     error
	calls         []string
}

func (f *fakeCF) Accounts(context.Context) ([]Account, error) {
	if f.token != f.goodToken {
		return nil, errors.New("Invalid API Token (1000)")
	}
	return []Account{{ID: "acc1", Name: "Personal"}, {ID: "acc2", Name: "Work"}}, nil
}
func (f *fakeCF) Zones(_ context.Context, account string) ([]Zone, error) {
	f.calls = append(f.calls, "zones:"+account)
	return []Zone{{ID: "z1", Name: "example.com"}, {ID: "z2", Name: "example.org"}}, nil
}
func (f *fakeCF) FindDatabase(context.Context, string, string) (string, error) {
	if f.existingDB {
		return "old-db", nil
	}
	return "", nil
}
func (f *fakeCF) CreateDatabase(_ context.Context, account, name string) (string, error) {
	f.calls = append(f.calls, "create-db:"+account+":"+name)
	return "db-123", nil
}
func (f *fakeCF) D1(account, id string) server.D1 {
	if id != "db-123" && id != "old-db" {
		f.t.Fatalf("D1 for unexpected database %s", id)
	}
	return f.db
}
func (f *fakeCF) WorkerExists(context.Context, string, string) (bool, error) { return false, nil }
func (f *fakeCF) UploadWorker(_ context.Context, account, name string, module []byte, dbID string) error {
	f.uploaded, f.uploadedDB = module, dbID
	f.calls = append(f.calls, "upload:"+name)
	return nil
}
func (f *fakeCF) DisableWorkersDev(context.Context, string, string) error {
	f.workersDevOff = true
	return nil
}
func (f *fakeCF) HostnameInUse(_ context.Context, zone, host string) (bool, error) {
	return f.takenHosts[host], nil
}
func (f *fakeCF) Domains(context.Context, string, string) ([]Domain, error) {
	if f.domain == "" && !f.existingDB {
		return nil, nil
	}
	return []Domain{{ID: "dom1", Hostname: "ccu.example.org"}}, nil
}
func (f *fakeCF) DeleteDomain(_ context.Context, _, id string) error {
	f.calls = append(f.calls, "delete-domain:"+id)
	return nil
}
func (f *fakeCF) DeleteWorker(_ context.Context, _, name string) error {
	f.calls = append(f.calls, "delete-worker:"+name)
	return nil
}
func (f *fakeCF) DeleteDatabase(_ context.Context, _, id string) error {
	f.calls = append(f.calls, "delete-db:"+id)
	return nil
}
func (f *fakeCF) AttachDomain(_ context.Context, account, zone, host, worker string) error {
	if f.attachErr != nil {
		return f.attachErr
	}
	f.domain = zone + "/" + host + "->" + worker
	return nil
}

func testAssets(t *testing.T) Assets {
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "worker", "migrations", "*.sql"))
	return Assets{
		Worker: func() ([]byte, error) { return []byte("export default {}"), nil },
		Migrations: func() ([]server.Migration, error) {
			var out []server.Migration
			for _, f := range files {
				b, _ := os.ReadFile(f)
				out = append(out, server.Migration{Name: filepath.Base(f), SQL: string(b)})
			}
			return out, nil
		},
	}
}

func testHooks(calls *[]string) *Hooks {
	clock := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	return &Hooks{
		Sleep:       func(context.Context, time.Duration) error { clock = clock.Add(10 * time.Second); return nil },
		Now:         func() time.Time { return clock },
		CheckOnline: func(context.Context, string) error { return nil },
		InstallSchedule: func(cfg *config.Config) (string, error) {
			*calls = append(*calls, "schedule")
			return "Background sync every 15 minutes", nil
		},
		FirstSync: func(context.Context) (string, error) {
			*calls = append(*calls, "sync")
			return "Uploaded the history", nil
		},
	}
}

func TestCreateDashboard(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	cf := &fakeCF{t: t, goodToken: "good-token", takenHosts: map[string]bool{"usage.example.org": true}, db: d1test.New(t)}
	factory := func(token string) Cloudflare { cf.token = token; return cf }
	answers := strings.Join([]string{
		"bad-token", "good-token", // the first token is refused
		"2",                        // account "Work"
		"2",                        // domain example.org
		"Bad_Name", "usage", "ccu", // invalid, taken, free
		"toronto", "y", // time zone search, confirm America/Toronto
		"Admin", "short", "correct horse battery", "correct horse battery",
		"Office PC", "1", // machine name, 15 minutes
		"y", // create
	}, "\n") + "\n"
	out := &bytes.Buffer{}
	var calls []string
	err := create(context.Background(), prompt.New(strings.NewReader(answers), out), testHooks(&calls), factory, testAssets(t))
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	text := out.String()
	for _, want := range []string{
		"Cloudflare didn't accept that token", "usage.example.org is already in use",
		"Ready to create:", "https://ccu.example.org", "✓ Created the database", "✓ Connected https://ccu.example.org",
		`Done! Open https://ccu.example.org and log in as "Admin"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("output lacks %q", want)
		}
	}
	if strings.Contains(text, "correct horse battery") {
		t.Fatal("password echoed in output")
	}
	if cf.calls[0] != "zones:acc2" || cf.uploadedDB != "db-123" || !cf.workersDevOff || cf.domain != "z2/ccu.example.org->ccunified" {
		t.Fatalf("cloudflare calls: %v domain=%s", cf.calls, cf.domain)
	}

	ctx := context.Background()
	q := func(sql string) []map[string]any {
		rows, err := cf.db.Query(ctx, sql)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if tz := q("SELECT value FROM settings WHERE key = 'timezone'")[0]["value"]; tz != "America/Toronto" {
		t.Fatalf("timezone %v", tz)
	}
	users := q("SELECT username, role FROM users")
	if len(users) != 1 || users[0]["username"] != "Admin" || users[0]["role"] != "admin" {
		t.Fatalf("users %v", users)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	machines := q("SELECT id, name, token_hash, sync_interval_minutes FROM machines")
	if len(machines) != 1 || machines[0]["id"] != cfg.MachineID || machines[0]["token_hash"] != login.TokenHash(cfg.Token) ||
		machines[0]["sync_interval_minutes"] != int64(15) || cfg.DashboardURL != "https://ccu.example.org" || cfg.Timezone != "America/Toronto" {
		t.Fatalf("machines %v config %+v", machines, cfg)
	}
	if strings.Join(calls, ",") != "schedule,sync" {
		t.Fatalf("hooks %v", calls)
	}
}

func TestCreateRefusesWhenADashboardExists(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	cf := &fakeCF{t: t, goodToken: "t", existingDB: true, db: d1test.New(t)}
	factory := func(token string) Cloudflare { cf.token = token; return cf }
	var calls []string
	err := create(context.Background(), prompt.New(strings.NewReader("t\n1\n"), &bytes.Buffer{}), testHooks(&calls), factory, testAssets(t))
	if err == nil || !strings.Contains(err.Error(), "ccunified server update") {
		t.Fatalf("got %v", err)
	}
	if len(cf.calls) != 0 {
		t.Fatalf("made changes: %v", cf.calls)
	}
}

func TestCreateCancelledAtSummaryChangesNothing(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	cf := &fakeCF{t: t, goodToken: "t", db: d1test.New(t)}
	factory := func(token string) Cloudflare { cf.token = token; return cf }
	answers := "t\n1\n1\n\nUTC\nadmin\nlong enough password\nlong enough password\nPC\n\nn\n"
	var calls []string
	err := create(context.Background(), prompt.New(strings.NewReader(answers), &bytes.Buffer{}), testHooks(&calls), factory, testAssets(t))
	if err == nil || !strings.Contains(err.Error(), "nothing was created") {
		t.Fatalf("got %v", err)
	}
	for _, c := range cf.calls {
		if !strings.HasPrefix(c, "zones:") {
			t.Fatalf("changed something: %v", cf.calls)
		}
	}
}

func TestCreateFailurePartwayOffersCleanup(t *testing.T) {
	t.Setenv("CCUNIFIED_HOME", t.TempDir())
	cf := &fakeCF{t: t, goodToken: "t", db: d1test.New(t), attachErr: errors.New("A DNS record already exists (code 100117)")}
	factory := func(token string) Cloudflare { cf.token = token; return cf }
	answers := "t\n1\n1\n\nUTC\nadmin\nlong enough password\nlong enough password\nPC\n\ny\ny\n"
	out := &bytes.Buffer{}
	var calls []string
	err := create(context.Background(), prompt.New(strings.NewReader(answers), out), testHooks(&calls), factory, testAssets(t))
	if err == nil || !strings.Contains(err.Error(), "DNS record already exists") {
		t.Fatalf("got %v\n%s", err, out)
	}
	got := strings.Join(cf.calls, ",")
	if !strings.Contains(got, "delete-worker:ccunified") || !strings.HasSuffix(got, "delete-db:db-123") {
		t.Fatalf("cleanup calls: %v", cf.calls)
	}
	if _, err := config.Load(); err == nil {
		t.Fatal("machine configured despite failed setup")
	}
	if len(calls) != 0 {
		t.Fatal("schedule or sync ran after a failed setup")
	}
}

func TestTokenTemplateURL(t *testing.T) {
	u := TokenTemplateURL()
	for _, want := range []string{"permissionGroupKeys=", "workers_scripts", "accountId=%2A", "zoneId=all"} {
		if !strings.Contains(u, want) {
			t.Errorf("%s lacks %s", u, want)
		}
	}
}
