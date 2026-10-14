package tzdetect

import (
	"testing"
	"time"
)

func TestWindowsMappingIsComplete(t *testing.T) {
	if len(windowsToIANA) < 130 {
		t.Fatalf("only %d Windows zones mapped", len(windowsToIANA))
	}
	for win, iana := range windowsToIANA {
		if _, err := time.LoadLocation(iana); err != nil {
			t.Errorf("%s -> %s: %v", win, iana, err)
		}
	}
	for win, want := range map[string]string{
		"Eastern Standard Time":   "America/New_York",
		"Iran Standard Time":      "Asia/Tehran",
		"W. Europe Standard Time": "Europe/Berlin",
	} {
		if got := FromWindowsID(win); got != want {
			t.Errorf("%s -> %s, want %s", win, got, want)
		}
	}
}

func TestFromLocaltimePath(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/share/zoneinfo/America/Toronto":     "America/Toronto",
		"../usr/share/zoneinfo/posix/Asia/Tehran": "Asia/Tehran",
		"/var/db/timezone/zoneinfo/Europe/London": "Europe/London",
		"/etc/somewhere/else":                     "",
	} {
		if got := FromLocaltimePath(in); got != want {
			t.Errorf("%s -> %q, want %q", in, got, want)
		}
	}
}

func TestLocalHonorsTZ(t *testing.T) {
	t.Setenv("TZ", "Asia/Tokyo")
	if got := Local(); got != "Asia/Tokyo" {
		t.Fatalf("got %s", got)
	}
	t.Setenv("TZ", "Not/AZone")
	if got := Local(); !Valid(got) {
		t.Fatalf("Local returned invalid %q", got)
	}
}

func TestSearch(t *testing.T) {
	got := Search("toronto")
	if len(got) != 1 || got[0] != "America/Toronto" {
		t.Fatalf("toronto: %v", got)
	}
	if got := Search("new york"); len(got) != 1 || got[0] != "America/New_York" {
		t.Fatalf("new york: %v", got)
	}
	if len(Search("")) != 0 {
		t.Fatal("empty query matched")
	}
}
