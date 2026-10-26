package prices

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Where the lists come from (the same as ccusage). CCUNIFIED_MODELSDEV_URL and
// CCUNIFIED_LITELLM_URL replace them, for tests.
const (
	ModelsDevURL = "https://models.dev/api.json"
	LiteLLMURL   = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
)

// MaxAge is how long a downloaded list is used before it's downloaded again.
const MaxAge = 24 * time.Hour

// maxListBytes caps a download (models.dev is about 6 MB).
const maxListBytes = 64 << 20

// Fetcher downloads the lists, keeping a copy in Dir for a day.
type Fetcher struct {
	Dir  string
	HTTP *http.Client
	Now  func() time.Time
}

func urlFor(env, fallback string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return fallback
}

// Load returns the lists: fresh copies when the saved ones are a day old or
// missing, otherwise the saved ones. When a download fails, an older copy is
// used if there is one; it fails only when neither list can be had.
func (f *Fetcher) Load(ctx context.Context) (*Lists, error) {
	md, errMD := f.list(ctx, "models.dev.json", urlFor("CCUNIFIED_MODELSDEV_URL", ModelsDevURL))
	ll, errLL := f.list(ctx, "litellm.json", urlFor("CCUNIFIED_LITELLM_URL", LiteLLMURL))
	if errMD != nil && errLL != nil {
		return nil, fmt.Errorf("couldn't get the price lists: %w", errMD)
	}
	return Parse(md, ll), nil
}

func (f *Fetcher) list(ctx context.Context, name, url string) ([]byte, error) {
	now := time.Now
	if f.Now != nil {
		now = f.Now
	}
	path := filepath.Join(f.Dir, name)
	saved, readErr := os.ReadFile(path)
	if info, err := os.Stat(path); readErr == nil && err == nil && now().Sub(info.ModTime()) < MaxAge {
		return saved, nil
	}
	fresh, err := f.download(ctx, url)
	if err != nil {
		if readErr == nil {
			return saved, nil
		}
		return nil, err
	}
	if err := os.MkdirAll(f.Dir, 0o700); err == nil {
		tmp := path + ".tmp"
		if os.WriteFile(tmp, fresh, 0o600) == nil {
			_ = os.Rename(tmp, path)
			_ = os.Chtimes(path, now(), now())
		}
	}
	return fresh, nil
}

func (f *Fetcher) download(ctx context.Context, url string) ([]byte, error) {
	client := f.HTTP
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxListBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxListBytes {
		return nil, fmt.Errorf("%s: larger than %d MB", url, maxListBytes>>20)
	}
	return data, nil
}
