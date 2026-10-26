// Package client talks to a ccunified dashboard's /agent endpoints.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/prices"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"

	// Trusted root certificates for systems that have none installed
	// (minimal Linux images); the system's own roots are used when present.
	_ "golang.org/x/crypto/x509roots/fallback"
)

// Client is an HTTP client for one dashboard.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 60 * time.Second, Transport: sharedTransport},
	}
}

// UserAgent identifies the program to the dashboard.
func UserAgent() string {
	return fmt.Sprintf("ccunified/%s (%s; %s)", version.Version, runtime.GOOS, runtime.GOARCH)
}

// APIError is an error response from the dashboard.
type APIError struct {
	Status     int
	Code       string
	Body       map[string]any
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("dashboard answered %d %s", e.Status, e.Code)
	}
	return fmt.Sprintf("dashboard answered %d", e.Status)
}

// Field returns a string field from the error body.
func (e *APIError) Field(name string) string {
	s, _ := e.Body[name].(string)
	return s
}

// IsCode reports whether err is an APIError with the given status and code.
func IsCode(err error, status int, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status && apiErr.Code == code
}

func (c *Client) do(ctx context.Context, path string, body any, auth bool, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", UserAgent())
	if auth {
		req.Header.Set("authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		apiErr := &APIError{Status: res.StatusCode}
		if json.Unmarshal(raw, &apiErr.Body) == nil {
			apiErr.Code, _ = apiErr.Body["error"].(string)
		}
		if secs, err := strconv.Atoi(res.Header.Get("retry-after")); err == nil && secs > 0 {
			apiErr.RetryAfter = time.Duration(secs) * time.Second
		}
		return apiErr
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("unexpected answer from the dashboard at %s (is this a ccunified dashboard?): %w", c.BaseURL, err)
	}
	return nil
}

// IngestResult is the dashboard's answer to an upload.
type IngestResult struct {
	OK            bool    `json:"ok"`
	ChangedRows   int     `json:"changed_rows"`
	Timezone      string  `json:"timezone"`
	ServerVersion string  `json:"server_version"`
	LatestVersion *string `json:"latest_version"`
	// SchemaVersions are the upload formats the dashboard accepts (absent
	// before ccunified 0.2, which accepts format 1 only).
	SchemaVersions []int `json:"schema_versions"`
}

// Ingest uploads one payload.
func (c *Client) Ingest(ctx context.Context, p *payload.Payload) (*IngestResult, error) {
	var out IngestResult
	if err := c.do(ctx, "/agent/ingest", p, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PairStartRequest describes a machine asking to join.
type PairStartRequest struct {
	MachineName         string `json:"machine_name"`
	OS                  string `json:"os"`
	Arch                string `json:"arch"`
	AgentVersion        string `json:"agent_version"`
	SyncIntervalMinutes int    `json:"sync_interval_minutes"`
}

// PairStart is the dashboard's answer: a code to show and a secret to poll with.
type PairStart struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURL string `json:"verification_url"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

func (c *Client) PairStart(ctx context.Context, req PairStartRequest) (*PairStart, error) {
	var out PairStart
	if err := c.do(ctx, "/agent/pair/start", req, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PairPoll is the state of a join request; Token is set once, when approved.
type PairPoll struct {
	Status  string `json:"status"`
	Token   string `json:"token"`
	Machine struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"machine"`
	Timezone string `json:"timezone"`
}

func (c *Client) PairPoll(ctx context.Context, deviceCode string) (*PairPoll, error) {
	var out PairPoll
	if err := c.do(ctx, "/agent/pair/poll", map[string]string{"device_code": deviceCode}, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Health checks that a ccunified dashboard answers at BaseURL and returns its version.
func (c *Client) Health(ctx context.Context) (string, error) {
	info, err := c.HealthInfo(ctx)
	if err != nil {
		return "", err
	}
	return info.Version, nil
}

// HealthInfo describes a dashboard.
type HealthInfo struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	// SchemaVersions are the upload formats it accepts; dashboards before
	// ccunified 0.2 don't say, and accept format 1 only.
	SchemaVersions []int `json:"schema_versions"`
}

// HealthInfo checks that a ccunified dashboard answers at BaseURL and
// describes it.
func (c *Client) HealthInfo(ctx context.Context) (*HealthInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/healthz", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", UserAgent())
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var body HealthInfo
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&body) != nil || !body.OK {
		return nil, fmt.Errorf("no ccunified dashboard answered at %s", c.BaseURL)
	}
	if len(body.SchemaVersions) == 0 {
		body.SchemaVersions = []int{1}
	}
	return &body, nil
}

// Prices sends models' prices from the public price lists and returns the
// models the dashboard has seen (send none to just ask). Dashboards before
// ccunified 0.5 answer 404.
func (c *Client) Prices(ctx context.Context, found map[string]prices.Prices) ([]string, error) {
	var out struct {
		Models []string `json:"models"`
	}
	if err := c.do(ctx, "/agent/prices", map[string]any{"prices": found}, true, &out); err != nil {
		return nil, err
	}
	return out.Models, nil
}
