// Command ccunified uploads this machine's Claude Code usage to a ccunified
// dashboard. Run "ccunified help" for the commands.
package main

import (
	"os"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/cli"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/install"
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/update"

	// Time zone data built in, so every IANA zone works on Windows too.
	_ "time/tzdata"
)

func main() {
	// Delete files a previous update replaced (they may have been in use then).
	if dir, err := install.ExeDir(); err == nil {
		update.CleanupOld(dir)
	}
	os.Exit(cli.Main(os.Args[1:], &cli.Env{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}))
}
