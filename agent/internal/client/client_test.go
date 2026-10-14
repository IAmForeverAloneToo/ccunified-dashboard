package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/payload"
)

func TestErrorsCarryCodeBodyAndRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer ccu_m_t" || !strings.HasPrefix(r.Header.Get("user-agent"), "ccunified/") {
			t.Errorf("headers: %v", r.Header)
		}
		w.Header().Set("retry-after", "3")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":"too_many_requests","retry_after_seconds":3}`))
	}))
	defer srv.Close()
	_, err := New(srv.URL, "ccu_m_t").Ingest(context.Background(), &payload.Payload{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 429 || apiErr.Code != "too_many_requests" || apiErr.RetryAfter != 3*time.Second {
		t.Fatalf("got %#v", err)
	}
	if !IsCode(err, 429, "too_many_requests") {
		t.Fatal("IsCode")
	}
}

func TestNonDashboardAnswersAreReportedClearly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>parked domain</html>"))
	}))
	defer srv.Close()
	c := New(srv.URL, "ccu_m_t")
	if _, err := c.Ingest(context.Background(), &payload.Payload{}); err == nil || !strings.Contains(err.Error(), "is this a ccunified dashboard") {
		t.Fatalf("got %v", err)
	}
	if _, err := c.Health(context.Background()); err == nil {
		t.Fatal("health accepted a non-dashboard")
	}
}

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"version":"1.2.3"}`))
	}))
	defer srv.Close()
	v, err := New(srv.URL, "").Health(context.Background())
	if err != nil || v != "1.2.3" {
		t.Fatalf("%q %v", v, err)
	}
}
