package server_test

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/login"
	. "github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server/d1test"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/serverassets"
)

func workerMigrations(t *testing.T) []serverassets.Migration {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "worker", "migrations", "*.sql"))
	var out []serverassets.Migration
	for _, f := range files {
		b, _ := os.ReadFile(f)
		out = append(out, serverassets.Migration{Name: filepath.Base(f), SQL: string(b)})
	}
	if len(out) == 0 {
		t.Fatal("no migrations")
	}
	return out
}

func migrated(t *testing.T) *d1test.DB {
	t.Helper()
	db := d1test.New(t)
	if _, err := ApplyMigrations(context.Background(), db, workerMigrations(t)); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestMigrationsApplyOnceAndAreRecorded(t *testing.T) {
	db := d1test.New(t)
	ctx := context.Background()
	m := workerMigrations(t)
	applied, err := ApplyMigrations(ctx, db, m)
	if err != nil || len(applied) != len(m) {
		t.Fatalf("%v %v", applied, err)
	}
	again, err := ApplyMigrations(ctx, db, m)
	if err != nil || len(again) != 0 {
		t.Fatalf("second run applied %v (%v)", again, err)
	}
	rows, _ := db.Query(ctx, "SELECT name FROM d1_migrations")
	if len(rows) != len(m) {
		t.Fatalf("recorded: %v", rows)
	}
}

func TestFailedMigrationLeavesNoTrace(t *testing.T) {
	db := d1test.New(t)
	ctx := context.Background()
	bad := []serverassets.Migration{{Name: "0001_bad.sql", SQL: "CREATE TABLE ok_table (x INT);\nNOT VALID SQL;\n"}}
	if _, err := ApplyMigrations(ctx, db, bad); err == nil {
		t.Fatal("bad migration succeeded")
	}
	if rows, _ := db.Query(ctx, "SELECT name FROM sqlite_master WHERE name = 'ok_table'"); len(rows) != 0 {
		t.Fatal("half-applied migration left a table behind")
	}
	if rows, _ := db.Query(ctx, "SELECT name FROM d1_migrations"); len(rows) != 0 {
		t.Fatal("failed migration was recorded")
	}
}

// verify checks a password the way the Worker does: browser-side key, then the stored hash.
func verify(t *testing.T, stored, password, installID, username string) bool {
	t.Helper()
	key, _ := login.Key(password, installID, username)
	parts := strings.Split(stored, "$")
	n, _ := strconv.Atoi(parts[1])
	salt, _ := base64.RawURLEncoding.DecodeString(parts[2])
	want, _ := base64.RawURLEncoding.DecodeString(parts[3])
	got, _ := pbkdf2.Key(sha256.New, string(key), salt, n, 32)
	return string(got) == string(want)
}

func TestCreateAdminAndResetPassword(t *testing.T) {
	db := migrated(t)
	ctx := context.Background()
	if err := CreateAdmin(ctx, db, "Admin", "short"); err == nil {
		t.Fatal("short password accepted")
	}
	if err := CreateAdmin(ctx, db, "Admin", "correct horse battery"); err != nil {
		t.Fatal(err)
	}
	if err := CreateAdmin(ctx, db, "admin", "another long password"); err != ErrUserExists {
		t.Fatalf("duplicate (case-insensitive) admin: %v", err)
	}
	installID := settingOf(t, db, "install_id")
	rows, _ := db.Query(ctx, "SELECT id, password_hash, role, must_change_password FROM users")
	if len(rows) != 1 || rows[0]["role"] != "admin" || rows[0]["must_change_password"] != int64(0) {
		t.Fatalf("users: %v", rows)
	}
	if !verify(t, rows[0]["password_hash"].(string), "correct horse battery", installID, "Admin") {
		t.Fatal("admin password doesn't verify")
	}

	// Locked out: sessions, lockouts and two-factor get cleared.
	id := rows[0]["id"]
	db.Query(ctx, "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('s', ?1, 0, 9e15, 0)", id)
	db.Query(ctx, "INSERT INTO login_attempts (key, window_start, failures) VALUES ('user:admin', 0, 99)")
	db.Query(ctx, "UPDATE users SET totp_enabled = 1, totp_secret = 'X', disabled_at = 5 WHERE id = ?1", id)
	if err := ResetPassword(ctx, db, "admin", "a brand new password", true); err != nil {
		t.Fatal(err)
	}
	rows, _ = db.Query(ctx, "SELECT password_hash, totp_enabled, disabled_at FROM users")
	if !verify(t, rows[0]["password_hash"].(string), "a brand new password", installID, "Admin") ||
		rows[0]["totp_enabled"] != int64(0) || rows[0]["disabled_at"] != nil {
		t.Fatalf("after reset: %v", rows)
	}
	for _, table := range []string{"sessions", "login_attempts"} {
		if r, _ := db.Query(ctx, "SELECT * FROM "+table); len(r) != 0 {
			t.Errorf("%s not cleared: %v", table, r)
		}
	}
	if err := ResetPassword(ctx, db, "nobody", "a brand new password", false); err == nil {
		t.Fatal("reset of unknown user succeeded")
	}
}

func TestRegisterMachineAndTimezone(t *testing.T) {
	db := migrated(t)
	ctx := context.Background()
	id, token, err := RegisterMachine(ctx, db, " Office PC ", "windows", "amd64", "1.0.0", 30)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := db.Query(ctx, "SELECT name, token_hash FROM machines WHERE id = ?1", id)
	if len(rows) != 1 || rows[0]["name"] != "Office PC" || rows[0]["token_hash"] != login.TokenHash(token) {
		t.Fatalf("machine: %v", rows)
	}
	if err := SetTimezone(ctx, db, "Mars/Base"); err == nil {
		t.Fatal("bad time zone accepted")
	}
	if err := SetTimezone(ctx, db, "Asia/Tehran"); err != nil {
		t.Fatal(err)
	}
	if tz := settingOf(t, db, "timezone"); tz != "Asia/Tehran" {
		t.Fatalf("timezone %s", tz)
	}
}

func settingOf(t *testing.T, db *d1test.DB, key string) string {
	t.Helper()
	rows, err := db.Query(context.Background(), "SELECT value FROM settings WHERE key = ?1", key)
	if err != nil || len(rows) != 1 {
		t.Fatalf("setting %s: %v %v", key, rows, err)
	}
	return rows[0]["value"].(string)
}
