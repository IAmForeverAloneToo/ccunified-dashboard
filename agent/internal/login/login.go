// Package login derives dashboard passwords exactly like the dashboard's
// browser code (worker/src/auth/client-kdf.ts) and stores them exactly like
// the Worker (worker/src/auth/password.ts). The setup wizard uses it to
// create the first admin account; schema/test-vectors/login-kdf.json keeps
// all implementations identical.
package login

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/text/unicode/norm"
)

const (
	clientIterations = 600_000
	serverIterations = 5_000
	keyBytes         = 32
)

// MinPasswordLength matches the dashboard's rule.
const MinPasswordLength = 10

// Salt is SHA-256("ccunified-login-v1|<install_id>|<lowercase username>").
func Salt(installID, username string) []byte {
	sum := sha256.Sum256([]byte("ccunified-login-v1|" + installID + "|" + strings.ToLower(username)))
	return sum[:]
}

// Key derives the login key a browser would send for this password.
func Key(password, installID, username string) ([]byte, error) {
	return pbkdf2.Key(sha256.New, norm.NFC.String(password), Salt(installID, username), clientIterations, keyBytes)
}

// StoredHash is what the Worker keeps for a login key:
// "v1$<iterations>$<salt>$<hash>", base64url without padding.
func StoredHash(key []byte) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash, err := pbkdf2.Key(sha256.New, string(key), salt, serverIterations, keyBytes)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	return fmt.Sprintf("v1$%d$%s$%s", serverIterations, enc.EncodeToString(salt), enc.EncodeToString(hash)), nil
}

// HashPassword derives and stores in one step.
func HashPassword(password, installID, username string) (string, error) {
	key, err := Key(password, installID, username)
	if err != nil {
		return "", err
	}
	return StoredHash(key)
}

// CheckNewPassword applies the dashboard's password rules.
func CheckNewPassword(password, username string) error {
	if len([]rune(password)) < MinPasswordLength {
		return fmt.Errorf("use at least %d characters", MinPasswordLength)
	}
	if strings.EqualFold(password, username) {
		return fmt.Errorf("don't use your username as your password")
	}
	return nil
}

// TokenHash is how the Worker stores machine upload keys and other secrets.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewMachineToken returns a fresh upload key ("ccu_m_" + 43 base64url characters).
func NewMachineToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "ccu_m_" + base64.RawURLEncoding.EncodeToString(b), nil
}
