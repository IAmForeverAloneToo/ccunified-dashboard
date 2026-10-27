package setup

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server/d1test"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

func existingInstall(t *testing.T) (*fakeCF, CloudflareFactory) {
	t.Helper()
	cf := &fakeCF{t: t, goodToken: "tok", existingDB: true, db: d1test.New(t)}
	setRunningVersion(t, "", errors.New("not reachable in tests"))
	ctx := context.Background()
	migrations, _ := testAssets(t).Migrations()
	if _, err := server.ApplyMigrations(ctx, cf.db, migrations[:0]); err != nil { // only the bookkeeping table
		t.Fatal(err)
	}
	return cf, func(token string) Cloudflare { cf.token = token; return cf }
}

func TestServerUpdateAppliesMigrationsAndUploads(t *testing.T) {
	cf, factory := existingInstall(t)
	out := &bytes.Buffer{}
	if err := serverUpdate(context.Background(), prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t)); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if string(cf.uploaded) != "export default {}" || cf.uploadedDB != "old-db" || !cf.workersDevOff {
		t.Fatalf("upload: %q to %s", cf.uploaded, cf.uploadedDB)
	}
	if !strings.Contains(out.String(), "Updated the database (0001_init.sql, 0002_tools.sql, 0003_models.sql, 0004_access.sql, 0005_prices.sql, 0006_removed.sql)") {
		t.Fatalf("output:\n%s", out)
	}
	// It explains how to create the token, like setup does.
	for _, want := range []string{TokenTemplateURL("ccunified server"), "Account > Workers Scripts > Edit", "Zone > DNS > Read", "Create Token"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	// Running it again finds nothing to migrate.
	out.Reset()
	serverUpdate(context.Background(), prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t))
	if !strings.Contains(out.String(), "already up to date") {
		t.Fatalf("second run:\n%s", out)
	}
}

// A dashboard from ccunified 0.1 (only the first migration) gets the
// migration for other tools, and its earlier usage is marked as Claude Code's.
func TestServerUpdateFromTheFirstRelease(t *testing.T) {
	cf, factory := existingInstall(t)
	ctx := context.Background()
	migrations, _ := testAssets(t).Migrations()
	if _, err := server.ApplyMigrations(ctx, cf.db, migrations[:1]); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO machines (id, name, os, arch, agent_version, sync_interval_minutes, token_hash, created_at)
		 VALUES ('m1', 'Office PC', 'windows', 'amd64', '0.1.2', 30, 'h1', 1), ('m2', 'New PC', 'linux', 'amd64', '0.1.2', 30, 'h2', 2)`,
		`INSERT INTO usage_daily (machine_id, source, day, model, input_tokens, output_tokens,
		   cache_creation_tokens, cache_read_tokens, cost_usd, updated_at)
		 VALUES ('m1', 'claude', '2026-10-01', 'claude-opus-5-5', 1, 2, 3, 4, 0.5, 1)`,
	} {
		if _, err := cf.db.Query(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	out := &bytes.Buffer{}
	if err := serverUpdate(ctx, prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t)); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out.String(), "Updated the database (0002_tools.sql, 0003_models.sql, 0004_access.sql, 0005_prices.sql, 0006_removed.sql)") {
		t.Fatalf("output:\n%s", out)
	}
	rows, err := cf.db.Query(ctx, "SELECT id, tools FROM machines ORDER BY id")
	if err != nil || len(rows) != 2 || rows[0]["tools"] != `["claude"]` || rows[1]["tools"] != "[]" {
		t.Fatalf("machines: %v %v", rows, err)
	}
	rows, err = cf.db.Query(ctx, "SELECT value FROM settings WHERE key = 'tools'")
	if err != nil || len(rows) != 1 || rows[0]["value"] != `["claude"]` {
		t.Fatalf("settings: %v %v", rows, err)
	}
	// The models seen so far, for the chart's colors.
	rows, err = cf.db.Query(ctx, "SELECT value FROM settings WHERE key = 'models'")
	if err != nil || len(rows) != 1 || rows[0]["value"] != `["claude-opus-5-5"]` {
		t.Fatalf("models: %v %v", rows, err)
	}
}

func TestServerResetPassword(t *testing.T) {
	cf, factory := existingInstall(t)
	ctx := context.Background()
	migrations, _ := testAssets(t).Migrations()
	server.ApplyMigrations(ctx, cf.db, migrations)
	if err := server.CreateAdmin(ctx, cf.db, "root", "the old password"); err != nil {
		t.Fatal(err)
	}
	answers := "tok\n1\n1\nthe new password\nthe new password\ny\n"
	out := &bytes.Buffer{}
	if err := ServerResetPassword(ctx, prompt.New(strings.NewReader(answers), out), factory, ""); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out.String(), "New password set for root") {
		t.Fatalf("output:\n%s", out)
	}
}

func TestServerRemoveNeedsExactConfirmation(t *testing.T) {
	cf, factory := existingInstall(t)
	answers := "tok\n1\nyes\nccu.example.org\n"
	out := &bytes.Buffer{}
	if err := ServerRemove(context.Background(), prompt.New(strings.NewReader(answers), out), factory); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if strings.Join(cf.calls, ",") != "delete-domain:dom1,delete-worker:ccunified,delete-db:old-db" {
		t.Fatalf("calls: %v", cf.calls)
	}
	if !strings.Contains(out.String(), "doesn't match") {
		t.Fatal("wrong confirmation accepted")
	}
}

func TestServerCommandsFindNoDashboard(t *testing.T) {
	cf := &fakeCF{t: t, goodToken: "tok", db: d1test.New(t)}
	factory := func(token string) Cloudflare { cf.token = token; return cf }
	err := ServerRemove(context.Background(), prompt.New(strings.NewReader("tok\n"), &bytes.Buffer{}), factory)
	if err == nil || !strings.Contains(err.Error(), "no ccunified dashboard was found") {
		t.Fatalf("got %v", err)
	}
}

func setRunningVersion(t *testing.T, v string, err error) {
	t.Helper()
	old := runningVersion
	runningVersion = func(context.Context, string) (string, error) { return v, err }
	t.Cleanup(func() { runningVersion = old })
}

func setProgramVersion(t *testing.T, v string) {
	t.Helper()
	old := version.Version
	version.Version = v
	t.Cleanup(func() { version.Version = old })
}

// An older program must not replace a newer dashboard.
func TestServerUpdateRefusesToDowngrade(t *testing.T) {
	cf, factory := existingInstall(t)
	setProgramVersion(t, "0.1.0")
	setRunningVersion(t, "0.1.1", nil)
	out := &bytes.Buffer{}
	err := serverUpdate(context.Background(), prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t))
	if err == nil || !strings.Contains(err.Error(), "newer than this program (0.1.0)") {
		t.Fatalf("got %v\n%s", err, out)
	}
	if cf.uploaded != nil {
		t.Error("the older dashboard was uploaded")
	}

	// The same or an older running version is updated as usual.
	for _, running := range []string{"0.1.0", "0.0.9"} {
		setRunningVersion(t, running, nil)
		if err := serverUpdate(context.Background(), prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t)); err != nil {
			t.Fatalf("running %s: %v\n%s", running, err, out)
		}
	}
}

func TestUserLabel(t *testing.T) {
	for _, c := range []struct {
		user map[string]any
		want string
	}{
		{map[string]any{"username": "alice", "role": "admin"}, "alice (admin)"},
		{map[string]any{"username": "bob", "role": "viewer"}, "bob (viewer)"},
		{map[string]any{"username": "carol", "role": nil}, "carol (department roles only)"},
	} {
		if got := userLabel(c.user); got != c.want {
			t.Errorf("userLabel(%v) = %q, want %q", c.user, got, c.want)
		}
	}
}
