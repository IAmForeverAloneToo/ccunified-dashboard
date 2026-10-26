// Package prices finds models' prices in the public price lists ccusage also
// uses (models.dev, then LiteLLM), for the dashboard's "price lists" pricing.
//
// A model is listed by many sellers, at different prices; the price used is
// the one from the model's maker (Anthropic for claude-*, OpenAI for gpt-*,
// Moonshot for kimi-*, and so on). Entries with no price (free subscription
// plans) are skipped. A model whose maker isn't known, or isn't in a list, has
// no price from that list; the dashboard then falls back to the next list,
// and finally to ccusage's own cost.
package prices

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
)

// Price is a model's price in US dollars per million tokens.
type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheWrite float64 `json:"cache_write"`
	CacheRead  float64 `json:"cache_read"`
	// Entry is the list entry the price came from, such as
	// "anthropic/claude-opus-5-5" (models.dev) or "moonshot/kimi-k3" (LiteLLM).
	Entry string `json:"entry"`
}

// Prices are a model's price in each list; nil where a list has none.
type Prices struct {
	ModelsDev *Price `json:"models_dev,omitempty"`
	LiteLLM   *Price `json:"litellm,omitempty"`
}

// Found reports whether either list has a price.
func (p Prices) Found() bool { return p.ModelsDev != nil || p.LiteLLM != nil }

// maker says where a model maker's own prices are in each list.
type maker struct {
	name *regexp.Regexp
	// modelsDev are the maker's providers on models.dev, in order.
	modelsDev []string
	// liteLLM are the key prefixes of the maker's entries in LiteLLM, in
	// order ("" for entries without a prefix).
	liteLLM []string
}

var makers = []maker{
	{regexp.MustCompile(`^claude-`), []string{"anthropic"}, []string{"", "anthropic/"}},
	{regexp.MustCompile(`^(gpt-|o\d|codex-|chatgpt-)`), []string{"openai"}, []string{"", "openai/"}},
	{regexp.MustCompile(`^gemini-`), []string{"google"}, []string{"gemini/", ""}},
	{regexp.MustCompile(`^kimi-`), []string{"moonshotai", "moonshotai-cn"}, []string{"moonshot/"}},
	{regexp.MustCompile(`^glm-`), []string{"zai", "zhipuai"}, []string{"zai/"}},
	{regexp.MustCompile(`^deepseek-`), []string{"deepseek"}, []string{"deepseek/"}},
	{regexp.MustCompile(`^grok-`), []string{"xai"}, []string{"xai/"}},
	{regexp.MustCompile(`^(qwen|qwq|qvq)`), []string{"alibaba"}, []string{"dashscope/"}},
	{regexp.MustCompile(`^(mistral|magistral|devstral|codestral)`), []string{"mistral"}, []string{"mistral/"}},
}

var (
	// Kimi's tools name their models "k3"; the lists call them "kimi-k3".
	kimiShort = regexp.MustCompile(`^k\d`)
	// A date at the end, such as claude-sonnet-4-5-20250929.
	dateSuffix = regexp.MustCompile(`-\d{8}$`)
)

// names are the names to look a model up by, in order: its own name
// (without a "provider/" prefix), then known variants.
func names(model string) []string {
	bare := strings.ToLower(model[strings.LastIndex(model, "/")+1:])
	out := []string{bare}
	if kimiShort.MatchString(bare) {
		out = append(out, "kimi-"+bare)
	}
	for _, n := range out {
		if d := dateSuffix.ReplaceAllString(n, ""); d != n {
			out = append(out, d)
		}
	}
	return out
}

func makerOf(name string) *maker {
	for i := range makers {
		if makers[i].name.MatchString(name) {
			return &makers[i]
		}
	}
	return nil
}

// Lists are the parsed price lists; either may be missing.
type Lists struct {
	modelsDev map[string]map[string]mdCost // provider → model → cost
	liteLLM   map[string]llCost            // key → cost
}

type mdCost struct {
	Input      *float64 `json:"input"`
	Output     *float64 `json:"output"`
	CacheRead  *float64 `json:"cache_read"`
	CacheWrite *float64 `json:"cache_write"`
}

type llCost struct {
	Input      *float64 `json:"input_cost_per_token"`
	Output     *float64 `json:"output_cost_per_token"`
	CacheWrite *float64 `json:"cache_creation_input_token_cost"`
	CacheRead  *float64 `json:"cache_read_input_token_cost"`
}

// Parse reads the lists' JSON (models.dev's api.json and LiteLLM's
// model_prices_and_context_window.json). A list that is empty or can't be
// read is left out; entries that can't be read are skipped.
func Parse(modelsDev, liteLLM []byte) *Lists {
	l := &Lists{modelsDev: map[string]map[string]mdCost{}, liteLLM: map[string]llCost{}}
	var providers map[string]json.RawMessage
	if json.Unmarshal(modelsDev, &providers) == nil {
		for id, raw := range providers {
			var p struct {
				Models map[string]json.RawMessage `json:"models"`
			}
			if json.Unmarshal(raw, &p) != nil {
				continue
			}
			models := map[string]mdCost{}
			for name, rawModel := range p.Models {
				var m struct {
					Cost *mdCost `json:"cost"`
				}
				if json.Unmarshal(rawModel, &m) == nil && m.Cost != nil {
					models[strings.ToLower(name)] = *m.Cost
				}
			}
			l.modelsDev[id] = models
		}
	}
	var entries map[string]json.RawMessage
	if json.Unmarshal(liteLLM, &entries) == nil {
		for key, raw := range entries {
			var c llCost
			if json.Unmarshal(raw, &c) == nil {
				l.liteLLM[strings.ToLower(key)] = c
			}
		}
	}
	return l
}

// price makes a Price from a list's numbers (per million tokens), or nil when
// the entry has no price. Cache reads and writes without a price of their own
// cost what input does.
func price(entry string, input, output, write, read *float64, scale float64) *Price {
	in, out := value(input)*scale, value(output)*scale
	if in <= 0 && out <= 0 {
		return nil
	}
	p := &Price{Input: in, Output: out, CacheWrite: in, CacheRead: in, Entry: entry}
	if write != nil {
		p.CacheWrite = *write * scale
	}
	if read != nil {
		p.CacheRead = *read * scale
	}
	return p
}

func value(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

// Lookup finds a model's price from its maker in each list.
func (l *Lists) Lookup(model string) Prices {
	var out Prices
	for _, name := range names(model) {
		m := makerOf(name)
		if m == nil {
			continue
		}
		if out.ModelsDev == nil {
			for _, provider := range m.modelsDev {
				if c, ok := l.modelsDev[provider][name]; ok {
					if p := price(provider+"/"+name, c.Input, c.Output, c.CacheWrite, c.CacheRead, 1); p != nil {
						out.ModelsDev = p
						break
					}
				}
			}
		}
		if out.LiteLLM == nil {
			for _, prefix := range m.liteLLM {
				if c, ok := l.liteLLM[prefix+name]; ok {
					if p := price(prefix+name, c.Input, c.Output, c.CacheWrite, c.CacheRead, 1e6); p != nil {
						out.LiteLLM = p
						break
					}
				}
			}
		}
	}
	return out
}

// Dashboard is where the prices go: it answers with the models it has seen.
type Dashboard interface {
	Prices(ctx context.Context, prices map[string]Prices) (models []string, err error)
}

// Report asks the dashboard which models it has seen, finds their prices in
// the lists and sends them. It returns how many models it found prices for.
func Report(ctx context.Context, d Dashboard, load func(context.Context) (*Lists, error)) (int, error) {
	models, err := d.Prices(ctx, map[string]Prices{})
	if err != nil {
		return 0, err
	}
	if len(models) == 0 {
		return 0, nil
	}
	lists, err := load(ctx)
	if err != nil {
		return 0, err
	}
	found := map[string]Prices{}
	for _, m := range models {
		if p := lists.Lookup(m); p.Found() {
			found[m] = p
		}
	}
	if len(found) == 0 {
		return 0, nil
	}
	if _, err := d.Prices(ctx, found); err != nil {
		return 0, err
	}
	return len(found), nil
}
