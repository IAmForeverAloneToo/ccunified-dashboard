// Command fetchccusage downloads the pinned ccusage program for one or more
// platforms from the npm registry, verifies it, and places it where the
// agent's build and tests expect it:
//
//	internal/ccusage/bin/<goos>-<goarch>/ccusage[.exe]
//
// The npm tarball must match the pinned sha512 integrity, and the extracted
// program must match the pinned SHA-256. With -update, the SHA-256 values in
// pinned.json are filled in instead of checked (used when moving to a new
// ccusage version, after updating the version and integrity fields).
//
//	go run ./tools/fetchccusage                       # this platform
//	go run ./tools/fetchccusage -platform windows/amd64 -platform linux/amd64
//	go run ./tools/fetchccusage -all -update
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type platform struct {
	Package   string `json:"package"`
	Integrity string `json:"integrity"`
	SHA256    string `json:"sha256"`
}

type pinned struct {
	Version   string               `json:"version"`
	Platforms map[string]*platform `json:"platforms"`
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	var platforms multiFlag
	all := flag.Bool("all", false, "fetch every pinned platform")
	update := flag.Bool("update", false, "write SHA-256 values into pinned.json instead of checking them")
	dir := flag.String("dir", ".", "agent module directory")
	flag.Var(&platforms, "platform", "goos/goarch to fetch (repeatable; default: this machine)")
	flag.Parse()

	if err := run(*dir, platforms, *all, *update); err != nil {
		fmt.Fprintln(os.Stderr, "fetchccusage:", err)
		os.Exit(1)
	}
}

func run(dir string, platforms []string, all, update bool) error {
	pinnedPath := filepath.Join(dir, "internal", "ccusage", "pinned.json")
	raw, err := os.ReadFile(pinnedPath)
	if err != nil {
		return err
	}
	var pin pinned
	if err := json.Unmarshal(raw, &pin); err != nil {
		return fmt.Errorf("%s: %w", pinnedPath, err)
	}
	if all {
		platforms = nil
		for p := range pin.Platforms {
			platforms = append(platforms, p)
		}
		sort.Strings(platforms)
	}
	if len(platforms) == 0 {
		platforms = []string{runtime.GOOS + "/" + runtime.GOARCH}
	}

	client := &http.Client{Timeout: 5 * time.Minute}
	for _, name := range platforms {
		p, ok := pin.Platforms[name]
		if !ok {
			return fmt.Errorf("platform %s is not pinned", name)
		}
		goos, goarch, _ := strings.Cut(name, "/")
		exe := "ccusage"
		if goos == "windows" {
			exe += ".exe"
		}
		out := filepath.Join(dir, "internal", "ccusage", "bin", goos+"-"+goarch, exe)
		if !update && p.SHA256 != "" {
			if have, err := os.ReadFile(out); err == nil {
				if sum := sha256.Sum256(have); hex.EncodeToString(sum[:]) == p.SHA256 {
					fmt.Printf("%-14s ccusage %s  already present and verified\n", name, pin.Version)
					continue
				}
			}
		}
		bin, err := fetch(client, p.Package, pin.Version, p.Integrity)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		sum := sha256.Sum256(bin)
		got := hex.EncodeToString(sum[:])
		switch {
		case update:
			p.SHA256 = got
		case p.SHA256 == "":
			return fmt.Errorf("%s: no SHA-256 pinned; run with -update", name)
		case p.SHA256 != got:
			return fmt.Errorf("%s: SHA-256 mismatch: pinned %s, got %s", name, p.SHA256, got)
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(out, bin, 0o755); err != nil {
			return err
		}
		fmt.Printf("%-14s ccusage %s  sha256 %s  -> %s\n", name, pin.Version, got, out)
	}

	if update {
		b, err := json.MarshalIndent(pin, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(pinnedPath, append(b, '\n'), 0o644)
	}
	return nil
}

// fetch downloads the package tarball, checks its npm integrity, and returns
// the ccusage program inside it.
func fetch(client *http.Client, pkg, version, integrity string) ([]byte, error) {
	algo, want, ok := strings.Cut(integrity, "-")
	if !ok || algo != "sha512" {
		return nil, fmt.Errorf("unsupported integrity %q", integrity)
	}
	// e.g. https://registry.npmjs.org/@ccusage/ccusage-linux-x64/-/ccusage-linux-x64-20.0.31.tgz
	name := pkg[strings.LastIndex(pkg, "/")+1:]
	tarball := fmt.Sprintf("https://registry.npmjs.org/%s/-/%s-%s.tgz", pkg, name, version)

	res, err := client.Get(tarball)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", tarball, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 200<<20))
	if err != nil {
		return nil, err
	}
	sum := sha512.Sum512(data)
	if got := base64.StdEncoding.EncodeToString(sum[:]); got != want {
		return nil, fmt.Errorf("tarball integrity mismatch: pinned sha512-%s, got sha512-%s", want, got)
	}

	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		base := filepath.Base(hdr.Name)
		if hdr.Typeflag == tar.TypeReg && strings.Contains(hdr.Name, "/bin/") &&
			(base == "ccusage" || base == "ccusage.exe") {
			return io.ReadAll(io.LimitReader(tr, 200<<20))
		}
	}
	return nil, errors.New("no ccusage program found in the package")
}
