package profiles

import (
	"slices"
	"strings"
	"testing"
)

func TestEnvKeepsTheBasicsAndUsesTheAccountsHome(t *testing.T) {
	base := []string{
		"PATH=/usr/bin", "HOME=/root", "CLAUDE_CONFIG_DIR=/root/.claude", "CODEX_HOME=/root/.codex",
		"HTTPS_PROXY=http://proxy:3128", "SECRET_TOKEN=x", "LANG=C.UTF-8",
	}
	env := Env(base, Profile{Name: "alice", Home: "/home/alice", UID: 1001, GID: 1001})
	for _, want := range []string{"PATH=/usr/bin", "HTTPS_PROXY=http://proxy:3128", "LANG=C.UTF-8"} {
		if !slices.Contains(env, want) {
			t.Errorf("%s missing from %v", want, env)
		}
	}
	for _, kv := range env {
		for _, gone := range []string{"/root", "SECRET_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"} {
			if strings.Contains(kv, gone) {
				t.Errorf("%q leaked into the account's environment", kv)
			}
		}
	}
}

func TestEnvDropsTheProxyPassword(t *testing.T) {
	base := []string{
		"HTTP_PROXY=http://root:s3cret@proxy.example:3128",
		"https_proxy=root:s3cret@proxy.example:8080",
		"ALL_PROXY=socks5://svc%40corp:s3cret@socks.example:1080/",
		"NO_PROXY=localhost,.corp",
	}
	env := Env(base, Profile{Name: "alice", Home: "/home/alice", UID: 1001, GID: 1001})
	for _, want := range []string{
		"HTTP_PROXY=http://proxy.example:3128",
		"https_proxy=proxy.example:8080",
		"ALL_PROXY=socks5://socks.example:1080/",
		"NO_PROXY=localhost,.corp",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("%s missing from %v", want, env)
		}
	}
	for _, kv := range env {
		if strings.Contains(kv, "s3cret") || strings.Contains(kv, "root") {
			t.Errorf("%q leaked into the account's environment", kv)
		}
	}
	if got, ok := withoutPassword("http://u:p@[::1"); ok {
		t.Errorf("an unreadable proxy address was kept as %q", got)
	}
}

func TestMachineName(t *testing.T) {
	p := Profile{Name: "alice"}
	if got := MachineName("LAPTOP-7", p); got != "LAPTOP-7 (alice)" {
		t.Errorf("got %q", got)
	}
	long := MachineName(strings.Repeat("h", 70), p)
	if n := len([]rune(long)); n != 64 || !strings.HasSuffix(long, ")") {
		t.Errorf("long name %q (%d characters)", long, n)
	}
	if got := MachineName("", Profile{Name: "bo\x07b"}); got != "computer (bob)" {
		t.Errorf("got %q", got)
	}
}
