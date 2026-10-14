// Package d1test provides a D1 backed by an in-memory SQLite database (the
// engine behind D1), for tests. Only test code imports it.
package d1test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"

	_ "modernc.org/sqlite"
)

type DB struct{ db *sql.DB }

func New(t testing.TB) *DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return &DB{db: db}
}

type queryer interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
}

func query(ctx context.Context, db queryer, q string, params ...any) ([]map[string]any, error) {
	rows, err := db.QueryContext(ctx, q, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				vals[i] = string(b)
			}
			row[c] = vals[i]
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (d *DB) Query(ctx context.Context, q string, params ...any) ([]map[string]any, error) {
	return query(ctx, d.db, q, params...)
}

func (d *DB) Batch(ctx context.Context, stmts []server.Statement) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, st := range stmts {
		if _, err := query(ctx, tx, st.SQL, st.Params...); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
