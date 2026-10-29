package cli

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func testCommand(t *testing.T, run func(ctx context.Context, env *Env, args []string) error) {
	t.Helper()
	register(&Command{Name: "test-interrupt", Hidden: true, Run: run})
	t.Cleanup(func() { delete(commands, "test-interrupt") })
}

// The first Ctrl+C cancels the command's context and lets it finish
// cleaning up.
func TestFirstInterruptCancelsAndWaits(t *testing.T) {
	cleanedUp := false
	testCommand(t, func(ctx context.Context, env *Env, args []string) error {
		<-ctx.Done()
		// Cleanup still works after the cancellation.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		cleanedUp = cleanupCtx.Err() == nil
		return ctx.Err()
	})
	interrupts := make(chan os.Signal, 2)
	interrupts <- os.Interrupt
	out := &bytes.Buffer{}
	code := run([]string{"test-interrupt"}, &Env{Stdout: out, Stderr: out}, interrupts)
	if code != exitInterrupted || !cleanedUp {
		t.Fatalf("exit code %d, cleaned up %v\n%s", code, cleanedUp, out)
	}
	if !strings.Contains(out.String(), "Context canceled") {
		t.Fatalf("output:\n%s", out)
	}
}

// A second Ctrl+C quits even if the command is stuck, such as waiting at a prompt.
func TestSecondInterruptQuits(t *testing.T) {
	old := stopHintDelay
	stopHintDelay = 0
	t.Cleanup(func() { stopHintDelay = old })
	stuck := make(chan struct{})
	t.Cleanup(func() { close(stuck) })
	testCommand(t, func(ctx context.Context, env *Env, args []string) error {
		<-stuck
		return nil
	})
	interrupts := make(chan os.Signal)
	out := &bytes.Buffer{}
	result := make(chan int)
	go func() {
		result <- run([]string{"test-interrupt"}, &Env{Stdout: out, Stderr: &bytes.Buffer{}}, interrupts)
	}()
	interrupts <- os.Interrupt
	interrupts <- os.Interrupt
	select {
	case code := <-result:
		if code != exitInterrupted {
			t.Fatalf("exit code %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a second Ctrl+C didn't quit")
	}
}
