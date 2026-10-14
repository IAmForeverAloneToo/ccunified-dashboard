// Package prompt asks questions in the terminal: plain lines and numbered
// menus, so it works the same in Windows consoles and over SSH.
package prompt

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// ErrCancelled means the input ended (Ctrl+D / Ctrl+Z) before an answer.
var ErrCancelled = errors.New("cancelled")

type Prompter struct {
	in  *bufio.Reader
	out io.Writer
	// secretFD is the terminal to read hidden input from, or -1 to read
	// visible lines (tests, piped input).
	secretFD int
}

// New returns a prompter. If in is a terminal, passwords are read without echo.
func New(in io.Reader, out io.Writer) *Prompter {
	p := &Prompter{in: bufio.NewReader(in), out: out, secretFD: -1}
	if f, ok := in.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		p.secretFD = int(f.Fd())
	}
	return p
}

func (p *Prompter) Printf(format string, args ...any) { fmt.Fprintf(p.out, format, args...) }

func (p *Prompter) line() (string, error) {
	s, err := p.in.ReadString('\n')
	if err != nil && (s == "" || !errors.Is(err, io.EOF)) {
		if errors.Is(err, io.EOF) {
			return "", ErrCancelled
		}
		return "", err
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// Text asks for a line. An empty answer takes def (if def is non-empty).
// validate may reject the answer, and the question is asked again.
func (p *Prompter) Text(label, def string, validate func(string) error) (string, error) {
	for {
		if def != "" {
			p.Printf("%s [%s]: ", label, def)
		} else {
			p.Printf("%s: ", label)
		}
		s, err := p.line()
		if err != nil {
			return "", err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			s = def
		}
		if s == "" {
			p.Printf("  Please enter a value.\n")
			continue
		}
		if validate != nil {
			if err := validate(s); err != nil {
				p.Printf("  %s\n", err)
				continue
			}
		}
		return s, nil
	}
}

// Secret asks for hidden input (a password or token).
func (p *Prompter) Secret(label string, validate func(string) error) (string, error) {
	for {
		p.Printf("%s: ", label)
		var s string
		if p.secretFD >= 0 {
			b, err := term.ReadPassword(p.secretFD)
			p.Printf("\n")
			if err != nil {
				return "", err
			}
			s = string(b)
		} else {
			line, err := p.line()
			if err != nil {
				return "", err
			}
			s = line
		}
		s = strings.TrimSpace(s)
		if s == "" {
			p.Printf("  Please enter a value.\n")
			continue
		}
		if validate != nil {
			if err := validate(s); err != nil {
				p.Printf("  %s\n", err)
				continue
			}
		}
		return s, nil
	}
}

// NewPassword asks for a password twice and checks it.
func (p *Prompter) NewPassword(label string, check func(string) error) (string, error) {
	for {
		pw, err := p.Secret(label, check)
		if err != nil {
			return "", err
		}
		again, err := p.Secret("Type it again", nil)
		if err != nil {
			return "", err
		}
		if pw == again {
			return pw, nil
		}
		p.Printf("  The two passwords don't match. Let's try again.\n")
	}
}

// Choose shows a numbered menu and returns the chosen index. def is the
// index chosen by just pressing Enter, or -1 for no default.
func (p *Prompter) Choose(label string, options []string, def int) (int, error) {
	p.Printf("%s\n", label)
	for i, o := range options {
		p.Printf("  %d) %s\n", i+1, o)
	}
	defText := ""
	if def >= 0 {
		defText = strconv.Itoa(def + 1)
	}
	answer, err := p.Text("Choose a number", defText, func(s string) error {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > len(options) {
			return fmt.Errorf("enter a number from 1 to %d", len(options))
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(answer)
	return n - 1, nil
}

// Confirm asks a yes/no question.
func (p *Prompter) Confirm(label string, def bool) (bool, error) {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	for {
		p.Printf("%s [%s]: ", label, hint)
		s, err := p.line()
		if err != nil {
			return false, err
		}
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "":
			return def, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
		p.Printf("  Please answer y or n.\n")
	}
}
