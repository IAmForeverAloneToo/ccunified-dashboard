package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// Cloudflare's public DNS, asked over HTTPS. A new dashboard address exists
// there as soon as Cloudflare creates it, while a computer's own DNS (or its
// router's) may still remember "doesn't exist" from an earlier lookup for up
// to half an hour.
const defaultPublicDNS = "https://cloudflare-dns.com/dns-query"

// PublicDNSURL is the DNS-over-HTTPS endpoint used; CCUNIFIED_DOH_URL
// replaces it (tests and local rehearsals only).
func PublicDNSURL() string {
	if u := os.Getenv("CCUNIFIED_DOH_URL"); u != "" {
		return u
	}
	return defaultPublicDNS
}

var publicDNSHTTP = &http.Client{Timeout: 10 * time.Second}

// LookupPublic returns host's addresses according to public DNS. No
// addresses and no error means the name doesn't exist (yet).
func LookupPublic(ctx context.Context, host string) ([]string, error) {
	var addrs []string
	for _, qtype := range []string{"A", "AAAA"} {
		found, err := queryPublicDNS(ctx, host, qtype)
		if err != nil {
			return nil, err
		}
		addrs = append(addrs, found...)
	}
	return addrs, nil
}

func queryPublicDNS(ctx context.Context, host, qtype string) ([]string, error) {
	q := url.Values{"name": {host}, "type": {qtype}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, PublicDNSURL()+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/dns-json")
	res, err := publicDNSHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("public DNS answered HTTP %d", res.StatusCode)
	}
	var body struct {
		Status int `json:"Status"`
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&body); err != nil {
		return nil, fmt.Errorf("unexpected answer from public DNS: %w", err)
	}
	const noError, nameError = 0, 3
	if body.Status == nameError {
		return nil, nil
	}
	if body.Status != noError {
		return nil, fmt.Errorf("public DNS answered status %d", body.Status)
	}
	var addrs []string
	for _, a := range body.Answer {
		// Only the final addresses (1 = A, 28 = AAAA), not CNAME steps.
		if (a.Type == 1 || a.Type == 28) && net.ParseIP(a.Data) != nil {
			addrs = append(addrs, a.Data)
		}
	}
	return addrs, nil
}

// fallbackDialer connects as usual, but when this computer's DNS says the
// host doesn't exist, it tries the addresses public DNS has for it. HTTPS
// still checks the dashboard's certificate, so this can't send uploads to
// anyone else.
type fallbackDialer struct {
	dial   func(ctx context.Context, network, addr string) (net.Conn, error)
	lookup func(ctx context.Context, host string) ([]string, error)
}

func (d *fallbackDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	conn, err := d.dial(ctx, network, addr)
	var dnsErr *net.DNSError
	if err == nil || !errors.As(err, &dnsErr) || !dnsErr.IsNotFound {
		return conn, err
	}
	host, port, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return nil, err
	}
	addrs, lookupErr := d.lookup(ctx, host)
	if lookupErr != nil || len(addrs) == 0 {
		return nil, err
	}
	for _, ip := range addrs {
		c, dialErr := d.dial(ctx, network, net.JoinHostPort(ip, port))
		if dialErr == nil {
			return c, nil
		}
		err = dialErr
	}
	return nil, err
}

// sharedTransport is used by every Client.
var sharedTransport = newTransport()

// newTransport is http.DefaultTransport (proxy settings included) with the
// public DNS fallback.
func newTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	d := &fallbackDialer{
		dial:   (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		lookup: LookupPublic,
	}
	t.DialContext = d.DialContext
	return t
}
