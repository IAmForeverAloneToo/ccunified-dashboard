package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
)

type recorded struct {
	method, path, query, contentType, body string
}

func fakeAPI(t *testing.T, handle func(r recorded) (int, string)) (*Client, *[]recorded) {
	t.Helper()
	var calls []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer tok" {
			t.Errorf("auth header: %q", r.Header.Get("authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		rec := recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("content-type"), string(b)}
		calls = append(calls, rec)
		status, body := handle(rec)
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	c := New("tok")
	c.BaseURL = srv.URL
	return c, &calls
}

func ok(result string) (int, string) {
	return 200, `{"success":true,"errors":[],"messages":[],"result":` + result + `}`
}

func TestUploadWorkerMultipart(t *testing.T) {
	c, calls := fakeAPI(t, func(recorded) (int, string) { return ok(`{}`) })
	if err := c.UploadWorker(context.Background(), "acc", "ccunified", []byte("export default {}"), "db-uuid"); err != nil {
		t.Fatal(err)
	}
	call := (*calls)[0]
	if call.method != "PUT" || call.path != "/accounts/acc/workers/scripts/ccunified" {
		t.Fatalf("%+v", call)
	}
	_, params, err := mime.ParseMediaType(call.contentType)
	if err != nil {
		t.Fatal(err)
	}
	mr := multipart.NewReader(strings.NewReader(call.body), params["boundary"])
	parts := map[string][2]string{}
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		b, _ := io.ReadAll(p)
		parts[p.FormName()] = [2]string{p.Header.Get("Content-Type"), string(b)}
		if p.FormName() == "worker.js" && p.FileName() != "worker.js" {
			t.Errorf("module file name %q", p.FileName())
		}
	}
	if parts["worker.js"] != [2]string{"application/javascript+module", "export default {}"} {
		t.Fatalf("module part: %v", parts["worker.js"])
	}
	var meta struct {
		MainModule        string              `json:"main_module"`
		CompatibilityDate string              `json:"compatibility_date"`
		Bindings          []map[string]string `json:"bindings"`
	}
	json.Unmarshal([]byte(parts["metadata"][1]), &meta)
	if meta.MainModule != "worker.js" || meta.CompatibilityDate != CompatibilityDate ||
		len(meta.Bindings) != 1 || meta.Bindings[0]["type"] != "d1" || meta.Bindings[0]["name"] != "DB" || meta.Bindings[0]["id"] != "db-uuid" {
		t.Fatalf("metadata: %s", parts["metadata"][1])
	}
}

func TestSubdomainAndDomainBodies(t *testing.T) {
	c, calls := fakeAPI(t, func(recorded) (int, string) { return ok(`{}`) })
	ctx := context.Background()
	c.DisableWorkersDev(ctx, "acc", "ccunified")
	c.AttachDomain(ctx, "acc", "zone1", "usage.example.com", "ccunified")
	if (*calls)[0].path != "/accounts/acc/workers/scripts/ccunified/subdomain" || (*calls)[0].body != `{"enabled":false,"previews_enabled":false}` {
		t.Fatalf("subdomain: %+v", (*calls)[0])
	}
	if (*calls)[1].method != "PUT" || (*calls)[1].path != "/accounts/acc/workers/domains" ||
		(*calls)[1].body != `{"hostname":"usage.example.com","service":"ccunified","zone_id":"zone1"}` {
		t.Fatalf("domain: %+v", (*calls)[1])
	}
}

func TestD1QueryAndBatch(t *testing.T) {
	c, calls := fakeAPI(t, func(recorded) (int, string) {
		return ok(`[{"results":[{"value":"abc"}],"success":true,"meta":{}}]`)
	})
	ctx := context.Background()
	db := c.D1("acc", "db1")
	rows, err := db.Query(ctx, "SELECT value FROM settings WHERE key = ?1", "install_id")
	if err != nil || len(rows) != 1 || rows[0]["value"] != "abc" {
		t.Fatalf("%v %v", rows, err)
	}
	if (*calls)[0].path != "/accounts/acc/d1/database/db1/query" || (*calls)[0].body != `{"params":["install_id"],"sql":"SELECT value FROM settings WHERE key = ?1"}` {
		t.Fatalf("query: %+v", (*calls)[0])
	}

	// Without parameters: one multi-statement SQL text (how Wrangler migrates).
	db.Batch(ctx, []server.Statement{{SQL: "CREATE TABLE a (x INT);"}, {SQL: "INSERT INTO a VALUES (1)"}})
	if got := (*calls)[1].body; got != `{"sql":"CREATE TABLE a (x INT);\nINSERT INTO a VALUES (1);"}` {
		t.Fatalf("migration batch: %s", got)
	}
	// With parameters: a D1 batch, numbers sent as text.
	db.Batch(ctx, []server.Statement{{SQL: "UPDATE u SET t = ?1 WHERE id = ?2", Params: []any{int64(1760000000000), "id1"}}, {SQL: "DELETE FROM s"}})
	if got := (*calls)[2].body; got != `{"batch":[{"params":["1760000000000","id1"],"sql":"UPDATE u SET t = ?1 WHERE id = ?2"},{"sql":"DELETE FROM s"}]}` {
		t.Fatalf("param batch: %s", got)
	}
}

func TestErrorsAndPaging(t *testing.T) {
	c, calls := fakeAPI(t, func(r recorded) (int, string) {
		switch {
		case r.path == "/accounts" && strings.Contains(r.query, "page=1"):
			return 200, `{"success":true,"errors":[],"result":[{"id":"a1","name":"One"}],"result_info":{"page":1,"total_pages":2}}`
		case r.path == "/accounts":
			return 200, `{"success":true,"errors":[],"result":[{"id":"a2","name":"Two"}],"result_info":{"page":2,"total_pages":2}}`
		case strings.HasSuffix(r.path, "/d1/database"):
			return ok(`[{"uuid":"u1","name":"ccunified-old"},{"uuid":"u2","name":"ccunified"}]`)
		case r.method == "DELETE":
			return 404, `{"success":false,"errors":[{"code":10007,"message":"not found"}]}`
		}
		return 403, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`
	})
	ctx := context.Background()
	accounts, err := c.Accounts(ctx)
	if err != nil || len(accounts) != 2 || accounts[1].Name != "Two" {
		t.Fatalf("%v %v", accounts, err)
	}
	if id, _ := c.FindDatabase(ctx, "a1", "ccunified"); id != "u2" {
		t.Fatalf("exact name match: %s", id)
	}
	if err := c.DeleteWorker(ctx, "a1", "gone"); err != nil {
		t.Fatalf("delete of a missing worker should succeed: %v", err)
	}
	_, err = c.Zones(ctx, "a1")
	if err == nil || !strings.Contains(err.Error(), "Authentication error (code 10000)") {
		t.Fatalf("error text: %v", err)
	}
	_ = calls
}
