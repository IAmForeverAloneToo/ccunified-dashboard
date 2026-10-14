package setup

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prompt"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server/d1test"
)

func existingInstall(t *testing.T) (*fakeCF, CloudflareFactory) {
	t.Helper()
	cf := &fakeCF{t: t, goodToken: "tok", existingDB: true, db: d1test.New(t)}
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
	if !strings.Contains(out.String(), "Updated the database (0001_init.sql)") {
		t.Fatalf("output:\n%s", out)
	}
	// Running it again finds nothing to migrate.
	out.Reset()
	serverUpdate(context.Background(), prompt.New(strings.NewReader("tok\n1\n"), out), factory, testAssets(t))
	if !strings.Contains(out.String(), "already up to date") {
		t.Fatalf("second run:\n%s", out)
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
