// Command ccunified uploads Claude Code usage from this machine to a
// ccunified dashboard.
package main

import (
	"fmt"
	"os"

	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/version"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println("ccunified", version.Version)
		return
	}
	fmt.Fprintln(os.Stderr, "usage: ccunified version")
	os.Exit(2)
}
