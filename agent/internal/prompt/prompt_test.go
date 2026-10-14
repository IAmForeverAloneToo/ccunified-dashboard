package prompt

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestText(t *testing.T) {
	out := &bytes.Buffer{}
	p := New(strings.NewReader("\nbad\ngood\n"), out)
	got, err := p.Text("Name", "", func(s string) error {
		if s == "bad" {
			return errors.New("not that one")
		}
		return nil
	})
	if err != nil || got != "good" {
		t.Fatalf("%q %v", got, err)
	}
	if !strings.Contains(out.String(), "Please enter a value") || !strings.Contains(out.String(), "not that one") {
		t.Fatalf("output: %s", out)
	}
	p = New(strings.NewReader("\n"), out)
	if got, _ := p.Text("Name", "default", nil); got != "default" {
		t.Fatalf("default: %q", got)
	}
}

func TestChooseAndConfirm(t *testing.T) {
	p := New(strings.NewReader("9\n2\n\nmaybe\ny\n"), &bytes.Buffer{})
	if i, err := p.Choose("Pick", []string{"a", "b"}, -1); err != nil || i != 1 {
		t.Fatalf("%d %v", i, err)
	}
	if i, _ := p.Choose("Pick", []string{"a", "b"}, 0); i != 0 {
		t.Fatalf("default choice: %d", i)
	}
	if ok, _ := p.Confirm("Sure?", false); !ok {
		t.Fatal("confirm")
	}
}

func TestNewPasswordRetriesOnMismatch(t *testing.T) {
	p := New(strings.NewReader("one-password\ntwo-password\nsame-password\nsame-password\n"), &bytes.Buffer{})
	pw, err := p.NewPassword("Password", nil)
	if err != nil || pw != "same-password" {
		t.Fatalf("%q %v", pw, err)
	}
}

func TestEndOfInputCancels(t *testing.T) {
	p := New(strings.NewReader(""), &bytes.Buffer{})
	if _, err := p.Text("Name", "", nil); !errors.Is(err, ErrCancelled) {
		t.Fatalf("got %v", err)
	}
	p = New(strings.NewReader("last line without newline"), &bytes.Buffer{})
	if got, err := p.Text("Name", "", nil); err != nil || got != "last line without newline" {
		t.Fatalf("%q %v", got, err)
	}
}
