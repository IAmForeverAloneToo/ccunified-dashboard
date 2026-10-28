package profiles

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestListFindsPeoplesAccounts(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	if uid < firstUID {
		if uid != 0 {
			t.Skip("needs an account id of 1000 or more, or root")
		}
		uid, gid = 1500, 1500
	}
	dir := t.TempDir()
	home := func(name string) string {
		h := filepath.Join(dir, "home", name)
		if err := os.MkdirAll(h, 0o755); err != nil {
			t.Fatal(err)
		}
		if os.Getuid() == 0 {
			os.Chown(h, uid, gid)
		}
		return h
	}
	alice, ldap := home("alice"), home("ldap-user")
	passwd := filepath.Join(dir, "passwd")
	os.WriteFile(passwd, fmt.Appendf(nil,
		"root:x:0:0:root:/root:/bin/bash\n"+
			"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"+
			"alice:x:%d:%d:Alice:%s:/bin/bash\n"+
			"svc:x:%d:%d:service:%s:/usr/sbin/nologin\n"+
			"gone:x:%d:%d:gone:%s:/bin/bash\n",
		uid, gid, alice, uid, gid, alice, uid+1, gid, filepath.Join(dir, "missing")), 0o644)
	passwdFile, homeRoot = passwd, filepath.Join(dir, "home")
	t.Cleanup(func() { passwdFile, homeRoot = "/etc/passwd", "/home" })

	got, err := List()
	if err != nil {
		t.Fatal(err)
	}
	want := []Profile{
		{Name: "alice", Home: alice, UID: uid, GID: gid},
		{Name: "ldap-user", Home: ldap, UID: uid, GID: gid},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
}
