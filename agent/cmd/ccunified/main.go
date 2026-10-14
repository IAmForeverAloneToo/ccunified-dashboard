// Command ccunified uploads this machine's Claude Code usage to a ccunified
// dashboard. Run "ccunified help" for the commands.
package main

import (
	"os"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/cli"

	// Time zone data built in, so every IANA zone works on Windows too.
	_ "time/tzdata"
)

func main() {
	os.Exit(cli.Main(os.Args[1:], &cli.Env{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}))
}
