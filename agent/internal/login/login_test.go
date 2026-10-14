package login

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "schema", "test-vectors", "login-kdf.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct {
			InstallID string `json:"install_id"`
			Username  string `json:"username"`
			Password  string `json:"password"`
			LoginKey  string `json:"login_key"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, v := range doc.Vectors {
		key, err := Key(v.Password, v.InstallID, v.Username)
		if err != nil {
			t.Fatal(err)
		}
		if got := base64.RawURLEncoding.EncodeToString(key); got != v.LoginKey {
			t.Errorf("%s: got %s, want %s", v.Username, got, v.LoginKey)
		}
	}
}

func TestStoredHashFormatAndVerification(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	stored, err := StoredHash(key)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^v1\$5000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$`).MatchString(stored) {
		t.Fatalf("format: %s", stored)
	}
	// Verify the way the Worker does.
	parts := strings.Split(stored, "$")
	n, _ := strconv.Atoi(parts[1])
	salt, _ := base64.RawURLEncoding.DecodeString(parts[2])
	want, _ := base64.RawURLEncoding.DecodeString(parts[3])
	got, _ := pbkdf2.Key(sha256.New, string(key), salt, n, 32)
	if string(got) != string(want) {
		t.Fatal("stored hash doesn't verify")
	}
	again, _ := StoredHash(key)
	if again == stored {
		t.Fatal("salt is not random")
	}
}

func TestCheckNewPassword(t *testing.T) {
	if CheckNewPassword("short", "x") == nil {
		t.Error("short password accepted")
	}
	if CheckNewPassword("AdminAdmin", "adminadmin") == nil {
		t.Error("username as password accepted")
	}
	if err := CheckNewPassword("correct horse battery", "admin"); err != nil {
		t.Error(err)
	}
}

func TestMachineToken(t *testing.T) {
	tok, err := NewMachineToken()
	if err != nil || !regexp.MustCompile(`^ccu_m_[A-Za-z0-9_-]{43}$`).MatchString(tok) {
		t.Fatalf("%q %v", tok, err)
	}
	if len(TokenHash(tok)) != 64 {
		t.Fatal("hash length")
	}
}
