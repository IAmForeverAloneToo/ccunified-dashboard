// Package cloudflare is a small client for the parts of the Cloudflare API
// that ccunified uses: accounts, zones, D1, Workers scripts and Workers
// custom domains. Request shapes follow Cloudflare's API reference and
// match what Wrangler sends.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/server"
)

// DefaultBaseURL is Cloudflare's API.
const DefaultBaseURL = "https://api.cloudflare.com/client/v4"

// CompatibilityDate is the Workers runtime date the dashboard is built for
// (keep in step with worker/wrangler.jsonc).
const CompatibilityDate = "2026-10-01"

// Client calls the Cloudflare API with one API token.
type Client struct {
	BaseURL   string
	Token     string
	HTTP      *http.Client
	UserAgent string
}

func New(token string) *Client {
	return &Client{BaseURL: DefaultBaseURL, Token: token, HTTP: &http.Client{Timeout: 2 * time.Minute}, UserAgent: "ccunified"}
}

// APIError is a failed Cloudflare API call.
type APIError struct {
	Status int
	Errors []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
}

func (e *APIError) Error() string {
	if len(e.Errors) == 0 {
		return fmt.Sprintf("Cloudflare API error (HTTP %d)", e.Status)
	}
	parts := make([]string, len(e.Errors))
	for i, x := range e.Errors {
		parts[i] = fmt.Sprintf("%s (code %d)", x.Message, x.Code)
	}
	return strings.Join(parts, "; ")
}

// IsNotFound reports whether err is a 404 from the API.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

type envelope struct {
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	ResultInfo *struct {
		Page       int `json:"page"`
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, contentType string, out any) (*envelope, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+c.Token)
	req.Header.Set("user-agent", c.UserAgent)
	if contentType != "" {
		req.Header.Set("content-type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		if res.StatusCode >= 300 {
			return nil, &APIError{Status: res.StatusCode}
		}
		return nil, fmt.Errorf("unexpected answer from Cloudflare (HTTP %d)", res.StatusCode)
	}
	if res.StatusCode >= 300 || !env.Success {
		apiErr := &APIError{Status: res.StatusCode}
		for _, e := range env.Errors {
			apiErr.Errors = append(apiErr.Errors, struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			}{e.Code, e.Message})
		}
		return nil, apiErr
	}
	if out != nil && len(env.Result) > 0 && string(env.Result) != "null" {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return nil, fmt.Errorf("unexpected result from Cloudflare: %w", err)
		}
	}
	return &env, nil
}

func (c *Client) getJSON(ctx context.Context, path string, out any) (*envelope, error) {
	return c.do(ctx, http.MethodGet, path, nil, "", out)
}

func (c *Client) sendJSON(ctx context.Context, method, path string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, method, path, bytes.NewReader(data), "application/json", out)
	return err
}

// paged fetches every page of a list endpoint.
func paged[T any](ctx context.Context, c *Client, path string, query url.Values) ([]T, error) {
	var all []T
	for page := 1; page <= 50; page++ {
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		q.Set("page", strconv.Itoa(page))
		q.Set("per_page", "50")
		var items []T
		env, err := c.getJSON(ctx, path+"?"+q.Encode(), &items)
		if err != nil {
			return nil, err
		}
		all = append(all, items...)
		if env.ResultInfo == nil || env.ResultInfo.TotalPages <= page || len(items) == 0 {
			break
		}
	}
	return all, nil
}

func esc(s string) string { return url.PathEscape(s) }

// Accounts lists the accounts the token can use.
func (c *Client) Accounts(ctx context.Context) ([]Account, error) {
	items, err := paged[struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}](ctx, c, "/accounts", nil)
	if err != nil {
		return nil, err
	}
	out := make([]Account, len(items))
	for i, it := range items {
		out[i] = Account{ID: it.ID, Name: it.Name}
	}
	return out, nil
}

// Zones lists the account's active domains.
func (c *Client) Zones(ctx context.Context, accountID string) ([]Zone, error) {
	items, err := paged[struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}](ctx, c, "/zones", url.Values{"account.id": {accountID}, "status": {"active"}})
	if err != nil {
		return nil, err
	}
	out := make([]Zone, len(items))
	for i, it := range items {
		out[i] = Zone{ID: it.ID, Name: it.Name}
	}
	return out, nil
}

// HostnameInUse reports whether hostname already has a DNS record or a
// Workers custom domain (Cloudflare can't attach a Worker over either).
func (c *Client) HostnameInUse(ctx context.Context, zoneID, hostname string) (bool, error) {
	var records []json.RawMessage
	if _, err := c.getJSON(ctx, "/zones/"+esc(zoneID)+"/dns_records?"+url.Values{"name": {hostname}}.Encode(), &records); err != nil {
		return false, err
	}
	return len(records) > 0, nil
}

// FindDatabase returns the ID of the D1 database called name, or "".
func (c *Client) FindDatabase(ctx context.Context, accountID, name string) (string, error) {
	items, err := paged[struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}](ctx, c, "/accounts/"+esc(accountID)+"/d1/database", url.Values{"name": {name}})
	if err != nil {
		return "", err
	}
	for _, it := range items {
		if it.Name == name { // the API's name filter is a search, not an exact match
			return it.UUID, nil
		}
	}
	return "", nil
}

func (c *Client) CreateDatabase(ctx context.Context, accountID, name string) (string, error) {
	var out struct {
		UUID string `json:"uuid"`
	}
	if err := c.sendJSON(ctx, http.MethodPost, "/accounts/"+esc(accountID)+"/d1/database", map[string]string{"name": name}, &out); err != nil {
		return "", err
	}
	if out.UUID == "" {
		return "", errors.New("Cloudflare created the database but returned no ID")
	}
	return out.UUID, nil
}

func (c *Client) DeleteDatabase(ctx context.Context, accountID, databaseID string) error {
	_, err := c.do(ctx, http.MethodDelete, "/accounts/"+esc(accountID)+"/d1/database/"+esc(databaseID), nil, "", nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// D1 returns a database handle that runs SQL through the D1 REST API.
func (c *Client) D1(accountID, databaseID string) server.D1 {
	return &d1{c: c, path: "/accounts/" + esc(accountID) + "/d1/database/" + esc(databaseID) + "/query"}
}

type d1 struct {
	c    *Client
	path string
}

type d1Result struct {
	Results []map[string]any `json:"results"`
	Success bool             `json:"success"`
}

// textParams converts parameters to strings, the type the D1 REST API takes.
func textParams(params []any) []any {
	out := make([]any, len(params))
	for i, p := range params {
		switch v := p.(type) {
		case nil:
			out[i] = nil
		case string:
			out[i] = v
		case int:
			out[i] = strconv.Itoa(v)
		case int64:
			out[i] = strconv.FormatInt(v, 10)
		case float64:
			out[i] = strconv.FormatFloat(v, 'g', -1, 64)
		case bool:
			out[i] = map[bool]string{true: "1", false: "0"}[v]
		default:
			out[i] = fmt.Sprint(v)
		}
	}
	return out
}

func (d *d1) Query(ctx context.Context, sql string, params ...any) ([]map[string]any, error) {
	body := map[string]any{"sql": sql}
	if len(params) > 0 {
		body["params"] = textParams(params)
	}
	var results []d1Result
	if err := d.c.sendJSON(ctx, http.MethodPost, d.path, body, &results); err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, nil
	}
	for _, r := range results {
		if !r.Success {
			return nil, errors.New("D1 reported a failed statement")
		}
	}
	return results[len(results)-1].Results, nil
}

// Batch sends statements without parameters as one multi-statement SQL
// text (the form Wrangler uses for migrations; D1 runs it as a batch and
// rolls back on failure), and statements with parameters as a D1 batch.
func (d *d1) Batch(ctx context.Context, stmts []server.Statement) error {
	hasParams := false
	for _, s := range stmts {
		hasParams = hasParams || len(s.Params) > 0
	}
	var body any
	if !hasParams {
		parts := make([]string, len(stmts))
		for i, s := range stmts {
			parts[i] = strings.TrimRight(strings.TrimSpace(s.SQL), ";")
		}
		body = map[string]any{"sql": strings.Join(parts, ";\n") + ";"}
	} else {
		batch := make([]map[string]any, len(stmts))
		for i, s := range stmts {
			item := map[string]any{"sql": s.SQL}
			if len(s.Params) > 0 {
				item["params"] = textParams(s.Params)
			}
			batch[i] = item
		}
		body = map[string]any{"batch": batch}
	}
	var results []d1Result
	if err := d.c.sendJSON(ctx, http.MethodPost, d.path, body, &results); err != nil {
		return err
	}
	for _, r := range results {
		if !r.Success {
			return errors.New("D1 reported a failed statement")
		}
	}
	return nil
}

// WorkerExists reports whether the account has a Worker script called name.
func (c *Client) WorkerExists(ctx context.Context, accountID, name string) (bool, error) {
	var scripts []struct {
		ID string `json:"id"`
	}
	if _, err := c.getJSON(ctx, "/accounts/"+esc(accountID)+"/workers/scripts", &scripts); err != nil {
		return false, err
	}
	for _, s := range scripts {
		if s.ID == name {
			return true, nil
		}
	}
	return false, nil
}

// UploadWorker uploads (or replaces) a single-module Worker bound to a D1 database as DB.
func (c *Client) UploadWorker(ctx context.Context, accountID, name string, module []byte, databaseID string) error {
	metadata, err := json.Marshal(map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": CompatibilityDate,
		"bindings": []map[string]string{
			{"type": "d1", "name": "DB", "id": databaseID},
		},
	})
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	meta, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="metadata"`},
		"Content-Type":        {"application/json"},
	})
	if err != nil {
		return err
	}
	meta.Write(metadata)
	// The module part's field name and file name must equal main_module.
	part, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="worker.js"; filename="worker.js"`},
		"Content-Type":        {"application/javascript+module"},
	})
	if err != nil {
		return err
	}
	part.Write(module)
	if err := mw.Close(); err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPut, "/accounts/"+esc(accountID)+"/workers/scripts/"+esc(name), &buf, mw.FormDataContentType(), nil)
	return err
}

// DisableWorkersDev turns off the script's workers.dev address and its preview URLs.
func (c *Client) DisableWorkersDev(ctx context.Context, accountID, name string) error {
	return c.sendJSON(ctx, http.MethodPost, "/accounts/"+esc(accountID)+"/workers/scripts/"+esc(name)+"/subdomain",
		map[string]bool{"enabled": false, "previews_enabled": false}, nil)
}

func (c *Client) DeleteWorker(ctx context.Context, accountID, name string) error {
	_, err := c.do(ctx, http.MethodDelete, "/accounts/"+esc(accountID)+"/workers/scripts/"+esc(name)+"?force=true", nil, "", nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// AttachDomain serves the Worker at hostname. Cloudflare creates the DNS
// record and certificate itself.
func (c *Client) AttachDomain(ctx context.Context, accountID, zoneID, hostname, worker string) error {
	return c.sendJSON(ctx, http.MethodPut, "/accounts/"+esc(accountID)+"/workers/domains",
		map[string]string{"hostname": hostname, "service": worker, "zone_id": zoneID}, nil)
}

// Domains lists the custom domains attached to a Worker.
func (c *Client) Domains(ctx context.Context, accountID, worker string) ([]Domain, error) {
	var items []struct {
		ID       string `json:"id"`
		Hostname string `json:"hostname"`
		Service  string `json:"service"`
	}
	if _, err := c.getJSON(ctx, "/accounts/"+esc(accountID)+"/workers/domains?"+url.Values{"service": {worker}}.Encode(), &items); err != nil {
		return nil, err
	}
	var out []Domain
	for _, it := range items {
		if it.Service == worker {
			out = append(out, Domain{ID: it.ID, Hostname: it.Hostname})
		}
	}
	return out, nil
}

func (c *Client) DeleteDomain(ctx context.Context, accountID, domainID string) error {
	_, err := c.do(ctx, http.MethodDelete, "/accounts/"+esc(accountID)+"/workers/domains/"+esc(domainID), nil, "", nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}
