// Package update replaces the installed ccunified with the latest release
// from GitHub, after verifying it against the release's SHA-256 checksums.
package update

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

// AssetName is the release archive for this platform.
func AssetName(goos, goarch string) string {
	if goos == "windows" {
		return fmt.Sprintf("ccunified_%s_%s.zip", goos, goarch)
	}
	return fmt.Sprintf("ccunified_%s_%s.tar.gz", goos, goarch)
}

// Updater downloads and installs releases.
type Updater struct {
	// APIBase is GitHub's API (replaced in tests).
	APIBase string
	Repo    string
	HTTP    *http.Client
	// InstallDir is the folder holding ccunified and ccusage.
	InstallDir string
	GOOS       string
	GOARCH     string
}

func New(installDir string) *Updater {
	return &Updater{
		APIBase: "https://api.github.com", Repo: version.Repo,
		HTTP:       &http.Client{Timeout: 5 * time.Minute},
		InstallDir: installDir, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
	}
}

// Release is a published release.
type Release struct {
	Version string
	Assets  map[string]string // file name -> download URL
}

func (u *Updater) get(ctx context.Context, url string, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", "ccunified/"+version.Version)
	if accept != "" {
		req.Header.Set("accept", accept)
	}
	res, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 200<<20))
}

// Latest returns the newest published release.
func (u *Updater) Latest(ctx context.Context) (*Release, error) {
	body, err := u.get(ctx, fmt.Sprintf("%s/repos/%s/releases/latest", u.APIBase, u.Repo), "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("couldn't check for updates: %w", err)
	}
	var r struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	rel := &Release{Version: strings.TrimPrefix(r.TagName, "v"), Assets: map[string]string{}}
	for _, a := range r.Assets {
		rel.Assets[a.Name] = a.URL
	}
	return rel, nil
}

// Download fetches this platform's archive and checks it against checksums.txt.
func (u *Updater) Download(ctx context.Context, rel *Release) ([]byte, error) {
	name := AssetName(u.GOOS, u.GOARCH)
	archiveURL, ok := rel.Assets[name]
	if !ok {
		return nil, fmt.Errorf("release %s has no download for %s/%s", rel.Version, u.GOOS, u.GOARCH)
	}
	sumsURL, ok := rel.Assets["checksums.txt"]
	if !ok {
		return nil, fmt.Errorf("release %s has no checksums.txt; refusing to install it", rel.Version)
	}
	sums, err := u.get(ctx, sumsURL, "")
	if err != nil {
		return nil, err
	}
	want := ""
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return nil, fmt.Errorf("checksums.txt has no entry for %s; refusing to install it", name)
	}
	archive, err := u.get(ctx, archiveURL, "")
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(archive)
	if got := hex.EncodeToString(sum[:]); got != want {
		return nil, fmt.Errorf("the download doesn't match its checksum (expected %s, got %s); not installing it", want, got)
	}
	return archive, nil
}

// Files extracts the program files (no folders) from a release archive.
func Files(archive []byte, goos string) (map[string][]byte, error) {
	files := map[string][]byte{}
	add := func(name string, r io.Reader) error {
		base := filepath.Base(filepath.FromSlash(name))
		if base == "." || base == ".." || strings.ContainsAny(base, `/\`) {
			return nil
		}
		b, err := io.ReadAll(io.LimitReader(r, 100<<20))
		if err != nil {
			return err
		}
		files[base] = b
		return nil
	}
	if goos == "windows" {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			err = add(f.Name, rc)
			rc.Close()
			if err != nil {
				return nil, err
			}
		}
	} else {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return nil, err
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, err
			}
			if h.Typeflag == tar.TypeReg {
				if err := add(h.Name, tr); err != nil {
					return nil, err
				}
			}
		}
	}
	main := "ccunified"
	if goos == "windows" {
		main += ".exe"
	}
	if _, ok := files[main]; !ok {
		return nil, fmt.Errorf("the release archive has no %s", main)
	}
	return files, nil
}

// Install puts the files into the install folder. Files in use (the running
// program) are renamed to *.old first, which Windows allows; they're
// deleted by CleanupOld on a later run.
func (u *Updater) Install(files map[string][]byte) error {
	staging, err := os.MkdirTemp(u.InstallDir, ".update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(staging, name), data, 0o755); err != nil {
			return err
		}
	}
	for name := range files {
		target := filepath.Join(u.InstallDir, name)
		if _, err := os.Stat(target); err == nil {
			old := target + ".old"
			os.Remove(old)
			if err := os.Rename(target, old); err != nil {
				return fmt.Errorf("couldn't replace %s: %w", name, err)
			}
		}
		if err := os.Rename(filepath.Join(staging, name), target); err != nil {
			return fmt.Errorf("couldn't install %s: %w", name, err)
		}
	}
	return nil
}

// CleanupOld removes files left behind by a previous update.
func CleanupOld(installDir string) {
	matches, _ := filepath.Glob(filepath.Join(installDir, "*.old"))
	for _, m := range matches {
		os.Remove(m)
	}
}

// InstalledVersion runs the newly installed program to confirm it works.
func (u *Updater) InstalledVersion(ctx context.Context) (string, error) {
	exe := filepath.Join(u.InstallDir, "ccunified")
	if u.GOOS == "windows" {
		exe += ".exe"
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, exe, "version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
