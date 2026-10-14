package client

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

// fakePublicDNS answers DNS-over-HTTPS JSON queries from a table.
func fakePublicDNS(t *testing.T, records map[string][]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accept") != "application/dns-json" {
			http.Error(w, "bad accept", http.StatusBadRequest)
			return
		}
		name, qtype := r.URL.Query().Get("name"), r.URL.Query().Get("type")
		addrs, ok := records[name]
		status := 0
		if !ok {
			status = 3 // NXDOMAIN
		}
		type answer struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		}
		answers := []answer{{Type: 5, Data: "cname.example.net."}}
		for _, a := range addrs {
			ip := net.ParseIP(a)
			if qtype == "A" && ip.To4() != nil {
				answers = append(answers, answer{Type: 1, Data: a})
			}
			if qtype == "AAAA" && ip.To4() == nil {
				answers = append(answers, answer{Type: 28, Data: a})
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"Status": status, "Answer": answers})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CCUNIFIED_DOH_URL", srv.URL)
	return srv
}

func TestLookupPublic(t *testing.T) {
	fakePublicDNS(t, map[string][]string{"usage.example.com": {"104.21.40.82", "2606:4700::1"}})
	ctx := context.Background()

	got, err := LookupPublic(ctx, "usage.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"104.21.40.82", "2606:4700::1"}) {
		t.Errorf("got %v", got)
	}

	got, err = LookupPublic(ctx, "missing.example.com")
	if err != nil || len(got) != 0 {
		t.Errorf("a name that doesn't exist: got %v, %v; want no addresses and no error", got, err)
	}
}

func TestLookupPublicReportsAnUnreachableServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	defer srv.Close()
	t.Setenv("CCUNIFIED_DOH_URL", srv.URL)
	if _, err := LookupPublic(context.Background(), "usage.example.com"); err == nil {
		t.Error("expected an error")
	}
}

// When this computer's DNS says the dashboard doesn't exist, the client
// connects to the address public DNS has for it.
func TestClientFallsBackToPublicDNS(t *testing.T) {
	dashboard := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "" || r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"ok":true,"version":"1.2.3"}`))
	}))
	defer dashboard.Close()
	_, port, _ := net.SplitHostPort(dashboard.Listener.Addr().String())
	fakePublicDNS(t, map[string][]string{"usage.example.com": {"127.0.0.1"}})

	var systemLookups []string
	d := &fallbackDialer{
		dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, _ := net.SplitHostPort(addr)
			if net.ParseIP(host) == nil {
				systemLookups = append(systemLookups, host)
				return nil, &net.OpError{Op: "dial", Net: network, Err: &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}}
			}
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
		},
		lookup: LookupPublic,
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = d.DialContext
	c := New("http://usage.example.com:"+port, "")
	c.HTTP.Transport = transport

	v, err := c.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v != "1.2.3" || !slices.Equal(systemLookups, []string{"usage.example.com"}) {
		t.Errorf("version %q, system lookups %v", v, systemLookups)
	}
}

// Other connection errors are not retried through public DNS.
func TestFallbackOnlyForNamesThatDontExist(t *testing.T) {
	lookups := 0
	d := &fallbackDialer{
		dial: func(context.Context, string, string) (net.Conn, error) {
			return nil, &net.DNSError{Err: "server misbehaving", Name: "usage.example.com", IsTemporary: true}
		},
		lookup: func(context.Context, string) ([]string, error) {
			lookups++
			return []string{"127.0.0.1"}, nil
		},
	}
	if _, err := d.DialContext(context.Background(), "tcp", "usage.example.com:443"); err == nil {
		t.Fatal("expected the original error")
	}
	if lookups != 0 {
		t.Errorf("public DNS was asked %d time(s)", lookups)
	}
}
