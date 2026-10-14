package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarGz(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipped(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	return buf.Bytes()
}

func fakeGitHub(t *testing.T, archiveName string, archive []byte, sums string) *httptest.Server {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/o/r/releases/latest":
			json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v1.2.3",
				"assets": []map[string]string{
					{"name": archiveName, "browser_download_url": srv.URL + "/dl/" + archiveName},
					{"name": "checksums.txt", "browser_download_url": srv.URL + "/dl/checksums.txt"},
				},
			})
		case "/dl/" + archiveName:
			w.Write(archive)
		case "/dl/checksums.txt":
			w.Write([]byte(sums))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestUpdateLinux(t *testing.T) {
	archive := tarGz(t, map[string]string{"ccunified": "new-agent", "ccusage": "new-ccusage", "LICENSE": "MIT"})
	name := AssetName("linux", "amd64")
	srv := fakeGitHub(t, name, archive, sha(archive)+"  "+name+"\n0000  other.zip\n")
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ccunified"), []byte("old-agent"), 0o755)
	u := &Updater{APIBase: srv.URL, Repo: "o/r", HTTP: srv.Client(), InstallDir: dir, GOOS: "linux", GOARCH: "amd64"}

	rel, err := u.Latest(context.Background())
	if err != nil || rel.Version != "1.2.3" {
		t.Fatalf("%+v %v", rel, err)
	}
	data, err := u.Download(context.Background(), rel)
	if err != nil {
		t.Fatal(err)
	}
	files, err := Files(data, "linux")
	if err != nil || len(files) != 3 {
		t.Fatalf("%v %v", files, err)
	}
	if err := u.Install(files); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ccunified")); string(b) != "new-agent" {
		t.Fatalf("not replaced: %s", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ccunified.old")); string(b) != "old-agent" {
		t.Fatal("old copy not kept for cleanup")
	}
	CleanupOld(dir)
	if _, err := os.Stat(filepath.Join(dir, "ccunified.old")); !os.IsNotExist(err) {
		t.Fatal("old copy not cleaned up")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".update-") {
			t.Fatal("staging folder left behind")
		}
	}
}

func TestUpdateRefusesBadChecksums(t *testing.T) {
	archive := zipped(t, map[string]string{"ccunified.exe": "x"})
	name := AssetName("windows", "amd64")
	for _, sums := range []string{
		strings.Repeat("0", 64) + "  " + name + "\n", // wrong hash
		sha(archive) + "  something-else.zip\n",      // no entry
	} {
		srv := fakeGitHub(t, name, archive, sums)
		u := &Updater{APIBase: srv.URL, Repo: "o/r", HTTP: srv.Client(), InstallDir: t.TempDir(), GOOS: "windows", GOARCH: "amd64"}
		rel, _ := u.Latest(context.Background())
		if _, err := u.Download(context.Background(), rel); err == nil {
			t.Fatalf("accepted with checksums %q", sums)
		}
	}
}

func TestFilesRejectsArchiveWithoutProgram(t *testing.T) {
	if _, err := Files(zipped(t, map[string]string{"README.txt": "hi"}), "windows"); err == nil {
		t.Fatal("accepted")
	}
	files, err := Files(zipped(t, map[string]string{"dir/../../ccunified.exe": "x"}), "windows")
	if err != nil || files["ccunified.exe"] == nil || len(files) != 1 {
		t.Fatalf("path components must be dropped: %v %v", files, err)
	}
}
