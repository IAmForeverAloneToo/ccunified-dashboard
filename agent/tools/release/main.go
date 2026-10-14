// Command release builds the files of a ccunified release:
//
//	ccunified_windows_amd64.zip     ccunified.exe, ccunifiedw.exe, ccusage.exe, LICENSE, THIRD_PARTY_NOTICES.txt
//	ccunified_linux_amd64.tar.gz    ccunified, ccusage, LICENSE, THIRD_PARTY_NOTICES.txt
//	install.ps1, install.sh         the one-line installers
//	checksums.txt                   SHA-256 of everything above
//
// The dashboard must be built into the program first (npm run build:assets).
//
//	go run ./tools/release -version 1.2.3 -out ../dist
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const modulePath = "github.com/IAmForeverAloneToo/ccunified-dashboard/agent"

// Archive timestamps are fixed so identical inputs give identical archives.
var fixedTime = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func main() {
	version := flag.String("version", "", "release version, like 1.2.3 (required)")
	repo := flag.String("repo", "IAmForeverAloneToo/ccunified-dashboard", "GitHub repository releases come from")
	out := flag.String("out", "../dist", "output folder (emptied first)")
	targets := flag.String("targets", "windows/amd64,linux/amd64", "comma-separated goos/goarch list")
	flag.Parse()
	if err := run(*version, *repo, *out, strings.Split(*targets, ",")); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

func run(version, repo, out string, targets []string) error {
	if !versionRe.MatchString(version) {
		return fmt.Errorf("-version must look like 1.2.3 or 1.2.3-rc.1, got %q", version)
	}
	if _, err := os.Stat(filepath.Join("internal", "serverassets", "assets", "worker.js")); err != nil {
		return fmt.Errorf("the dashboard isn't built into the program; run npm run build:assets first")
	}
	if err := os.RemoveAll(out); err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	license, err := os.ReadFile(filepath.Join("..", "LICENSE"))
	if err != nil {
		return err
	}
	notices, err := thirdPartyNotices(targets)
	if err != nil {
		return err
	}

	for _, target := range targets {
		goos, goarch, ok := strings.Cut(strings.TrimSpace(target), "/")
		if !ok {
			return fmt.Errorf("bad target %q", target)
		}
		if err := sh("go", nil, "run", "./tools/fetchccusage", "-platform", goos+"/"+goarch); err != nil {
			return err
		}
		exe := ""
		if goos == "windows" {
			exe = ".exe"
		}
		files := map[string][]byte{"LICENSE": license, "THIRD_PARTY_NOTICES.txt": notices}
		ldflags := fmt.Sprintf("-s -w -X %[1]s/internal/version.Version=%[2]s -X %[1]s/internal/version.Repo=%[3]s", modulePath, version, repo)
		builds := map[string]string{"ccunified" + exe: ldflags}
		if goos == "windows" {
			builds["ccunifiedw.exe"] = ldflags + " -H=windowsgui"
		}
		tmp, err := os.MkdirTemp("", "ccunified-release")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		for name, flags := range builds {
			bin := filepath.Join(tmp, goos+"-"+goarch+"-"+name)
			env := []string{"GOOS=" + goos, "GOARCH=" + goarch, "CGO_ENABLED=0"}
			if err := sh("go", env, "build", "-trimpath", "-buildvcs=false", "-ldflags", flags, "-o", bin, "./cmd/ccunified"); err != nil {
				return err
			}
			if files[name], err = os.ReadFile(bin); err != nil {
				return err
			}
		}
		ccusage := filepath.Join("internal", "ccusage", "bin", goos+"-"+goarch, "ccusage"+exe)
		if files["ccusage"+exe], err = os.ReadFile(ccusage); err != nil {
			return err
		}

		var archive []byte
		name := fmt.Sprintf("ccunified_%s_%s", goos, goarch)
		if goos == "windows" {
			archive, err = makeZip(files)
			name += ".zip"
		} else {
			archive, err = makeTarGz(files)
			name += ".tar.gz"
		}
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(out, name), archive, 0o644); err != nil {
			return err
		}
		fmt.Printf("built %s (%d bytes)\n", name, len(archive))
	}

	for _, script := range []string{"install.sh", "install.ps1"} {
		b, err := os.ReadFile(filepath.Join("..", "scripts", script))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(out, script), b, 0o644); err != nil {
			return err
		}
	}
	return writeChecksums(out)
}

func sh(name string, env []string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

func sortedNames(files map[string][]byte) []string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func isProgram(name string) bool {
	return name == "ccunified" || name == "ccusage" || strings.HasSuffix(name, ".exe")
}

func makeZip(files map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range sortedNames(files) {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: fixedTime})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(files[name]); err != nil {
			return nil, err
		}
	}
	err := zw.Close()
	return buf.Bytes(), err
}

func makeTarGz(files map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.ModTime = fixedTime
	tw := tar.NewWriter(gz)
	for _, name := range sortedNames(files) {
		mode := int64(0o644)
		if isProgram(name) {
			mode = 0o755
		}
		hdr := &tar.Header{Name: name, Mode: mode, Size: int64(len(files[name])), ModTime: fixedTime, Typeflag: tar.TypeReg, Format: tar.FormatPAX}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := tw.Write(files[name]); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	err := gz.Close()
	return buf.Bytes(), err
}

func writeChecksums(out string) error {
	entries, err := os.ReadDir(out)
	if err != nil {
		return err
	}
	var lines []string
	for _, e := range entries {
		if e.IsDir() || e.Name() == "checksums.txt" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(out, e.Name()))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		lines = append(lines, hex.EncodeToString(sum[:])+"  "+e.Name())
	}
	sort.Strings(lines)
	return os.WriteFile(filepath.Join(out, "checksums.txt"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

// thirdPartyNotices collects the licenses of everything built into a release:
// the Go toolchain's standard library, the Go modules the program uses, the
// bundled ccusage, and the npm packages bundled into the dashboard.
func thirdPartyNotices(targets []string) ([]byte, error) {
	var b strings.Builder
	b.WriteString("ccunified includes the following third-party software.\n")
	section := func(title, text string) {
		b.WriteString("\n" + strings.Repeat("=", 78) + "\n" + title + "\n" + strings.Repeat("=", 78) + "\n\n")
		b.WriteString(strings.TrimSpace(text) + "\n")
	}

	goroot, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return nil, err
	}
	goLicense, err := os.ReadFile(filepath.Join(strings.TrimSpace(string(goroot)), "LICENSE"))
	if err != nil {
		return nil, err
	}
	section("The Go programming language standard library (BSD-3-Clause)", string(goLicense))

	modules := map[string]string{} // "path version" -> dir
	for _, target := range targets {
		goos, goarch, _ := strings.Cut(target, "/")
		cmd := exec.Command("go", "list", "-deps", "-f", "{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}}\t{{.Dir}}{{end}}{{end}}", "./cmd/ccunified")
		cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("go list: %w", err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if id, dir, ok := strings.Cut(line, "\t"); ok {
				modules[id] = dir
			}
		}
	}
	ids := make([]string, 0, len(modules))
	for id := range modules {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		text, err := findLicense(modules[id])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", id, err)
		}
		if strings.HasPrefix(id, "golang.org/x/crypto/x509roots/fallback ") {
			text += "\n\nThe certificate list it contains is derived from the Mozilla CA Certificate Program."
		}
		section("Go module "+id, text)
	}

	ccusage, err := os.ReadFile(filepath.Join("internal", "ccusage", "LICENSE.ccusage"))
	if err != nil {
		return nil, err
	}
	section("ccusage (https://github.com/ccusage/ccusage), MIT", string(ccusage))

	for _, pkg := range []string{"../worker/package.json", "../dashboard/package.json"} {
		raw, err := os.ReadFile(pkg)
		if err != nil {
			return nil, err
		}
		var manifest struct {
			Dependencies map[string]string `json:"dependencies"`
		}
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return nil, err
		}
		names := make([]string, 0, len(manifest.Dependencies))
		for n := range manifest.Dependencies {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			text, err := findLicense(filepath.Join("..", "node_modules", n))
			if err != nil {
				return nil, fmt.Errorf("npm package %s: %w", n, err)
			}
			section("npm package "+n+" "+manifest.Dependencies[n]+" (bundled into the dashboard)", text)
		}
	}
	return []byte(b.String()), nil
}

func findLicense(dir string) (string, error) {
	var found string
	err := fs.WalkDir(os.DirFS(dir), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || found != "" {
			return err
		}
		if d.IsDir() && path != "." {
			return fs.SkipDir
		}
		upper := strings.ToUpper(d.Name())
		if strings.HasPrefix(upper, "LICENSE") || strings.HasPrefix(upper, "LICENCE") || strings.HasPrefix(upper, "COPYING") {
			found = path
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("no license file in %s", dir)
	}
	b, err := os.ReadFile(filepath.Join(dir, found))
	return string(b), err
}
