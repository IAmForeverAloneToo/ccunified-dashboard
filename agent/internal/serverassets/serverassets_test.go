package serverassets

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSplitSQL(t *testing.T) {
	got := SplitSQL("-- comment\nCREATE TABLE a (x INT);\r\n\nINSERT INTO a VALUES\n  (1),\n  (2);\n-- trailing\n")
	if len(got) != 2 || !strings.HasPrefix(got[1], "INSERT INTO a VALUES") || strings.Contains(got[0], "comment") {
		t.Fatalf("%q", got)
	}
}

// The real migrations (from worker/migrations) must split cleanly and run
// on SQLite, the engine behind D1.
func TestWorkerMigrationsApply(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "worker", "migrations", "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, stmt := range SplitSQL(string(b)) {
			if _, err := db.Exec(stmt); err != nil {
				t.Fatalf("%s: %v\n%s", filepath.Base(f), err, stmt)
			}
		}
	}
	var id string
	if err := db.QueryRow("SELECT value FROM settings WHERE key = 'install_id'").Scan(&id); err != nil || len(id) != 32 {
		t.Fatalf("install_id %q: %v", id, err)
	}
}

func TestEmbeddedAssetsMatchSources(t *testing.T) {
	migrations, err := Migrations()
	if err != nil {
		t.Skip("assets not built into this test binary (npm run build:assets)")
	}
	for _, m := range migrations {
		src, err := os.ReadFile(filepath.Join("..", "..", "..", "worker", "migrations", m.Name))
		if err != nil || string(src) != m.SQL {
			t.Errorf("%s differs from worker/migrations; run npm run build:assets", m.Name)
		}
	}
	if w, err := Worker(); err != nil || len(w) < 1000 {
		t.Errorf("worker.js missing or tiny: %v", err)
	}
}
