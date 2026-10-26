package prices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Shaped like the real lists: one model sold by several sellers at different
// prices, a subscription plan at $0, and entries for other makers' models.
const modelsDevJSON = `{
  "venice": {"models": {"claude-opus-5-5": {"cost": {"input": 4.8, "output": 24, "cache_read": 0.24, "cache_write": 6}}}},
  "anthropic": {"models": {
    "claude-opus-5-5": {"cost": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5}},
    "claude-sonnet-4-5": {"cost": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75}}
  }},
  "unorouter": {"models": {"gpt-5.5": {"cost": {"input": 0.1875, "output": 1.125}}}},
  "openai": {"models": {"gpt-5.5": {"cost": {"input": 5, "output": 30, "cache_read": 0.5}}}},
  "kimi-code-plan-global": {"models": {"k3": {"cost": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}}}},
  "moonshotai": {"models": {"kimi-k3": {"cost": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3}}}},
  "opencode": {"models": {"gemini-3-pro": {"cost": {"input": 2, "output": 12}}}},
  "broken": {"models": "not a map"}
}`

const liteLLMJSON = `{
  "sample_spec": {"input_cost_per_token": "a string", "max_tokens": "set to max"},
  "claude-mythos-5-1": {"input_cost_per_token": 1e-05, "output_cost_per_token": 5e-05, "cache_creation_input_token_cost": 1.25e-05, "cache_read_input_token_cost": 1e-06},
  "claude-opus-5-5": {"input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05},
  "azure/gpt-5.5": {"input_cost_per_token": 5.5e-06, "output_cost_per_token": 3.3e-05},
  "moonshot/kimi-k3": {"input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05},
  "replicate/google/gemini-3-pro": {"input_cost_per_token": 2e-06, "output_cost_per_token": 1.2e-05}
}`

func TestLookupUsesTheMakersPrice(t *testing.T) {
	l := Parse([]byte(modelsDevJSON), []byte(liteLLMJSON))
	cases := []struct {
		model     string
		modelsDev *Price
		liteLLM   *Price
	}{
		// Anthropic's price, not a reseller's.
		{"claude-opus-5-5",
			&Price{4, 20, 5, 0.2, "anthropic/claude-opus-5-5"},
			&Price{4, 20, 4, 4, "claude-opus-5-5"}}, // no cache prices: input's
		// A tool that names the provider (OpenCode): the same entry.
		{"anthropic/claude-opus-5-5",
			&Price{4, 20, 5, 0.2, "anthropic/claude-opus-5-5"},
			&Price{4, 20, 4, 4, "claude-opus-5-5"}},
		// OpenAI's, not a much cheaper reseller's; Azure's LiteLLM entry isn't OpenAI's.
		{"gpt-5.5", &Price{5, 30, 5, 0.5, "openai/gpt-5.5"}, nil},
		// "k3" is Kimi K3; the $0 subscription-plan entry is skipped.
		{"k3",
			&Price{3, 15, 3, 0.3, "moonshotai/kimi-k3"},
			&Price{3, 15, 3, 3, "moonshot/kimi-k3"}},
		// A dated name falls back to the undated entry.
		{"claude-sonnet-4-5-20250929", &Price{3, 15, 3.75, 0.3, "anthropic/claude-sonnet-4-5"}, nil},
		// Only in LiteLLM.
		{"claude-mythos-5-1", nil, &Price{10, 50, 12.5, 1, "claude-mythos-5-1"}},
		// Only sold by others: no maker's price in either list.
		{"gemini-3-pro", nil, nil},
		// Unknown maker.
		{"some-new-model", nil, nil},
	}
	for _, c := range cases {
		got := l.Lookup(c.model)
		if !samePrice(got.ModelsDev, c.modelsDev) || !samePrice(got.LiteLLM, c.liteLLM) {
			t.Errorf("%s: got models.dev %+v, LiteLLM %+v; want %+v, %+v",
				c.model, got.ModelsDev, got.LiteLLM, c.modelsDev, c.liteLLM)
		}
	}
	if (Prices{}).Found() || !l.Lookup("gpt-5.5").Found() {
		t.Error("Found is wrong")
	}
}

func samePrice(a, b *Price) bool {
	if a == nil || b == nil {
		return a == b
	}
	near := func(x, y float64) bool { d := x - y; return d < 1e-9 && d > -1e-9 }
	return near(a.Input, b.Input) && near(a.Output, b.Output) &&
		near(a.CacheWrite, b.CacheWrite) && near(a.CacheRead, b.CacheRead) && a.Entry == b.Entry
}

func TestParseToleratesMissingOrBrokenLists(t *testing.T) {
	l := Parse(nil, []byte("not json"))
	if l.Lookup("claude-opus-5-5").Found() {
		t.Error("found a price in no lists")
	}
	l = Parse(nil, []byte(liteLLMJSON))
	if p := l.Lookup("claude-opus-5-5"); p.ModelsDev != nil || p.LiteLLM == nil {
		t.Errorf("with only LiteLLM: %+v", p)
	}
}

func TestFetcherDownloadsOnceADayAndFallsBackToItsCopy(t *testing.T) {
	var hits atomic.Int32
	up := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if !up {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/md" {
			w.Write([]byte(modelsDevJSON))
		} else {
			w.Write([]byte(liteLLMJSON))
		}
	}))
	defer srv.Close()
	t.Setenv("CCUNIFIED_MODELSDEV_URL", srv.URL+"/md")
	t.Setenv("CCUNIFIED_LITELLM_URL", srv.URL+"/ll")

	now := time.Date(2026, 10, 26, 9, 0, 0, 0, time.UTC)
	f := &Fetcher{Dir: t.TempDir(), Now: func() time.Time { return now }}
	ctx := context.Background()
	l, err := f.Load(ctx)
	if err != nil || !l.Lookup("k3").Found() {
		t.Fatalf("first load: %v", err)
	}
	if hits.Load() != 2 {
		t.Fatalf("downloads: %d", hits.Load())
	}
	// Within a day: the saved copies.
	now = now.Add(23 * time.Hour)
	if _, err := f.Load(ctx); err != nil || hits.Load() != 2 {
		t.Fatalf("second load: %v, downloads %d", err, hits.Load())
	}
	// A day later the lists are downloaded again; if that fails, the copies do.
	now = now.Add(2 * time.Hour)
	up = false
	l, err = f.Load(ctx)
	if err != nil || hits.Load() != 4 || !l.Lookup("gpt-5.5").Found() {
		t.Fatalf("stale load: %v, downloads %d", err, hits.Load())
	}
	// With no copies and no network, it fails.
	os.RemoveAll(filepath.Join(f.Dir))
	if _, err := f.Load(ctx); err == nil {
		t.Fatal("loaded lists from nowhere")
	}
}

type fakeDashboard struct {
	models []string
	got    []map[string]Prices
	err    error
}

func (f *fakeDashboard) Prices(_ context.Context, p map[string]Prices) ([]string, error) {
	f.got = append(f.got, p)
	return f.models, f.err
}

func TestReportSendsThePricesOfTheDashboardsModels(t *testing.T) {
	lists := Parse([]byte(modelsDevJSON), []byte(liteLLMJSON))
	load := func(context.Context) (*Lists, error) { return lists, nil }
	d := &fakeDashboard{models: []string{"claude-opus-5-5", "k3", "some-new-model"}}
	n, err := Report(context.Background(), d, load)
	if err != nil || n != 2 {
		t.Fatalf("Report: %d, %v", n, err)
	}
	// First it asks, then it sends what it found (nothing for unknown models).
	if len(d.got) != 2 || len(d.got[0]) != 0 || len(d.got[1]) != 2 || d.got[1]["k3"].ModelsDev.Input != 3 {
		t.Fatalf("calls: %+v", d.got)
	}
	// No models yet: nothing to download or send.
	d = &fakeDashboard{}
	loaded := false
	if n, err := Report(context.Background(), d, func(context.Context) (*Lists, error) {
		loaded = true
		return lists, nil
	}); err != nil || n != 0 || loaded || len(d.got) != 1 {
		t.Fatalf("empty dashboard: %d, %v, loaded %v", n, err, loaded)
	}
}
