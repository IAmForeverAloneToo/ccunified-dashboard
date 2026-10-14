// Package cli implements the ccunified commands.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
)

// Command is one subcommand.
type Command struct {
	Name    string
	Summary string
	Usage   string
	Run     func(ctx context.Context, env *Env, args []string) error
	Hidden  bool
}

// Env carries the program's input and output.
type Env struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

func (e *Env) Printf(format string, args ...any) { fmt.Fprintf(e.Stdout, format, args...) }

var commands = map[string]*Command{}

func register(c *Command) { commands[c.Name] = c }

// UsageError is printed with the command's usage.
type UsageError struct{ Msg string }

func (e *UsageError) Error() string { return e.Msg }

func newFlags(name string, env *Env) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	return fs
}

func help(env *Env) {
	env.Printf("ccunified uploads this machine's Claude Code usage to your ccunified dashboard.\n\n")
	env.Printf("Usage: ccunified <command> [options]\n\nCommands:\n")
	names := make([]string, 0, len(commands))
	for name, c := range commands {
		if !c.Hidden {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		env.Printf("  %-12s %s\n", name, commands[name].Summary)
	}
	env.Printf("\nRun \"ccunified help <command>\" for details.\n")
}

// Main runs the program and returns its exit code.
func Main(args []string, env *Env) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if len(args) == 0 {
		help(env)
		return 2
	}
	name := args[0]
	switch name {
	case "-h", "--help", "help":
		if len(args) > 1 {
			if c, ok := commands[args[1]]; ok {
				env.Printf("%s\n\nUsage: %s\n", c.Summary, c.Usage)
				return 0
			}
		}
		help(env)
		return 0
	case "-v", "--version":
		name = "version"
	}
	c, ok := commands[name]
	if !ok {
		fmt.Fprintf(env.Stderr, "ccunified: unknown command %q\n\n", name)
		help(env)
		return 2
	}
	err := c.Run(ctx, env, args[1:])
	var usageErr *UsageError
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		return 0
	case errors.As(err, &usageErr):
		fmt.Fprintf(env.Stderr, "ccunified %s: %s\nUsage: %s\n", name, usageErr.Msg, c.Usage)
		return 2
	default:
		fmt.Fprintf(env.Stderr, "ccunified %s: %s\n", name, firstUpper(err.Error()))
		return 1
	}
}

func firstUpper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
