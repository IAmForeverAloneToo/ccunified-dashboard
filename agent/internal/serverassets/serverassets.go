// Package serverassets holds the dashboard (the bundled Cloudflare Worker)
// and its database migrations, built into ccunified so the setup wizard can
// install or update the Cloudflare side without any other tools.
package serverassets

import (
	"embed"
	"errors"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

//go:embed all:assets
var files embed.FS

// ErrNotBuilt means this program was compiled without the dashboard.
var ErrNotBuilt = errors.New("this build of ccunified doesn't include the dashboard; build it with: npm run build:assets")

// Worker returns the bundled Worker script (an ES module).
func Worker() ([]byte, error) {
	b, err := files.ReadFile("assets/worker.js")
	if err != nil {
		return nil, ErrNotBuilt
	}
	return b, nil
}

// Migration is one migration file.
type Migration struct {
	Name string // e.g. "0001_init.sql"
	SQL  string
}

// Migrations returns the migrations in the order they must be applied.
func Migrations() ([]Migration, error) {
	entries, err := fs.ReadDir(files, "assets/migrations")
	if err != nil {
		return nil, ErrNotBuilt
	}
	var out []Migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		b, err := files.ReadFile("assets/migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, Migration{Name: e.Name(), SQL: string(b)})
	}
	if len(out) == 0 {
		return nil, ErrNotBuilt
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

var statementEnd = regexp.MustCompile(`(?m);\s*$`)

// SplitSQL splits a migration into statements the same way the Worker's
// test harness does: comment lines are dropped, and a statement ends with a
// semicolon at the end of a line.
func SplitSQL(sql string) []string {
	var kept []string
	for _, line := range strings.Split(strings.ReplaceAll(sql, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			kept = append(kept, line)
		}
	}
	var out []string
	for _, stmt := range statementEnd.Split(strings.Join(kept, "\n"), -1) {
		if s := strings.TrimSpace(stmt); s != "" {
			out = append(out, s)
		}
	}
	return out
}
