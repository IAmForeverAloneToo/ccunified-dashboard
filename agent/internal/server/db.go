// Package server installs, updates and maintains the Cloudflare side of a
// dashboard: the D1 database, the Worker and the custom domain.
package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/login"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/serverassets"
)

// Statement is one SQL statement with positional parameters (?1, ?2, …).
type Statement struct {
	SQL    string
	Params []any
}

// D1 runs SQL against the dashboard's database.
type D1 interface {
	// Query runs one statement and returns its rows.
	Query(ctx context.Context, sql string, params ...any) ([]map[string]any, error)
	// Batch runs statements in order as one transaction: all or nothing.
	// Parameters are sent as text; SQLite converts them to the column types.
	Batch(ctx context.Context, stmts []Statement) error
}

var safeMigrationName = regexp.MustCompile(`^[0-9A-Za-z_.-]+\.sql$`)

// migrationsTable is the same table Wrangler uses, so `wrangler d1
// migrations` and ccunified agree on what has been applied.
const migrationsTable = `CREATE TABLE IF NOT EXISTS d1_migrations(
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`

// Migration is one migration file (see serverassets).
type Migration = serverassets.Migration

// ApplyMigrations applies the migrations that haven't been applied yet.
// Each migration runs as one transaction together with its bookkeeping row.
func ApplyMigrations(ctx context.Context, db D1, migrations []serverassets.Migration) ([]string, error) {
	if _, err := db.Query(ctx, migrationsTable); err != nil {
		return nil, fmt.Errorf("preparing migrations: %w", err)
	}
	rows, err := db.Query(ctx, "SELECT name FROM d1_migrations")
	if err != nil {
		return nil, err
	}
	done := map[string]bool{}
	for _, r := range rows {
		if name, ok := r["name"].(string); ok {
			done[name] = true
		}
	}
	var applied []string
	for _, m := range migrations {
		if done[m.Name] {
			continue
		}
		if !safeMigrationName.MatchString(m.Name) {
			return applied, fmt.Errorf("unexpected migration file name %q", m.Name)
		}
		// No parameters: like Wrangler, a migration and its bookkeeping row
		// go to D1 as one multi-statement SQL text, which D1 runs as a batch
		// and rolls back as a whole if any statement fails.
		var stmts []Statement
		for _, s := range serverassets.SplitSQL(m.SQL) {
			stmts = append(stmts, Statement{SQL: s})
		}
		stmts = append(stmts, Statement{SQL: "INSERT INTO d1_migrations (name) VALUES ('" + m.Name + "')"})
		if err := db.Batch(ctx, stmts); err != nil {
			return applied, fmt.Errorf("applying %s: %w", m.Name, err)
		}
		applied = append(applied, m.Name)
	}
	return applied, nil
}

func setting(ctx context.Context, db D1, key string) (string, error) {
	rows, err := db.Query(ctx, "SELECT value FROM settings WHERE key = ?1", key)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", fmt.Errorf("the dashboard database has no %q setting", key)
	}
	v, _ := rows[0]["value"].(string)
	return v, nil
}

// SetTimezone sets the time zone the dashboard's days use.
func SetTimezone(ctx context.Context, db D1, tz string) error {
	if _, err := time.LoadLocation(tz); err != nil {
		return fmt.Errorf("invalid time zone %q", tz)
	}
	_, err := db.Query(ctx, "UPDATE settings SET value = ?1 WHERE key = 'timezone'", tz)
	return err
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ErrUserExists means the username is already taken.
var ErrUserExists = errors.New("a user with that name already exists")

// CreateAdmin adds an admin account. The password is derived exactly as the
// dashboard's login page derives it, so it works there right away.
func CreateAdmin(ctx context.Context, db D1, username, password string) error {
	if err := login.CheckNewPassword(password, username); err != nil {
		return err
	}
	rows, err := db.Query(ctx, "SELECT 1 FROM users WHERE username = ?1", username)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return ErrUserExists
	}
	installID, err := setting(ctx, db, "install_id")
	if err != nil {
		return err
	}
	hash, err := login.HashPassword(password, installID, username)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	_, err = db.Query(ctx,
		`INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at)
		 VALUES (?1, ?2, ?3, 'admin', ?4, ?4)`,
		newID(), username, hash, now)
	return err
}

// RegisterMachine adds this machine directly (setup has full access, so no
// approval is needed) and returns its id and upload key.
func RegisterMachine(ctx context.Context, db D1, name, os, arch, agentVersion string, interval int) (id, token string, err error) {
	token, err = login.NewMachineToken()
	if err != nil {
		return "", "", err
	}
	id = newID()
	_, err = db.Query(ctx,
		`INSERT INTO machines (id, name, os, arch, agent_version, sync_interval_minutes, token_hash, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		id, strings.TrimSpace(name), os, arch, agentVersion, interval, login.TokenHash(token), time.Now().UnixMilli())
	return id, token, err
}

// ResetPassword sets a new password for a user (for an admin who is locked
// out), re-enables the account, ends its sessions and clears login lockouts.
// With clear2FA, two-factor is turned off too.
func ResetPassword(ctx context.Context, db D1, username, password string, clear2FA bool) error {
	if err := login.CheckNewPassword(password, username); err != nil {
		return err
	}
	rows, err := db.Query(ctx, "SELECT id, username FROM users WHERE username = ?1", username)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("there is no user called %q", username)
	}
	id, _ := rows[0]["id"].(string)
	stored, _ := rows[0]["username"].(string) // the salt uses the name as stored
	installID, err := setting(ctx, db, "install_id")
	if err != nil {
		return err
	}
	hash, err := login.HashPassword(password, installID, stored)
	if err != nil {
		return err
	}
	stmts := []Statement{
		{SQL: "UPDATE users SET password_hash = ?1, password_changed_at = ?2, must_change_password = 0, disabled_at = NULL WHERE id = ?3",
			Params: []any{hash, time.Now().UnixMilli(), id}},
		{SQL: "DELETE FROM sessions WHERE user_id = ?1", Params: []any{id}},
		{SQL: "DELETE FROM login_attempts WHERE key = ?1", Params: []any{"user:" + strings.ToLower(stored)}},
	}
	if clear2FA {
		stmts = append(stmts,
			Statement{SQL: "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?1", Params: []any{id}},
			Statement{SQL: "DELETE FROM recovery_codes WHERE user_id = ?1", Params: []any{id}},
		)
	}
	return db.Batch(ctx, stmts)
}

// ListUsers returns usernames and roles (for choosing whom to reset).
func ListUsers(ctx context.Context, db D1) ([]map[string]any, error) {
	return db.Query(ctx, "SELECT username, role, totp_enabled, disabled_at FROM users ORDER BY username COLLATE NOCASE")
}
