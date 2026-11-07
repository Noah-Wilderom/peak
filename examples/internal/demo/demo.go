// Package demo gives the examples a common lifetime, optional pprof server,
// and an opt-in connection to Peak's runtime-agent socket.
package demo

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	peak "github.com/Noah-Wilderom/peak/sdk/go"
)

type Options struct {
	duration *time.Duration
	pprof    *string
}

// Flags must be called before flag.Parse in each example.
func Flags() Options {
	return Options{
		duration: flag.Duration("duration", time.Minute, "run time; 0 runs until stopped"),
		pprof:    flag.String("pprof", "", "optional pprof listen address, e.g. 127.0.0.1:6060"),
	}
}

func (o Options) Run(name string, work func(context.Context) error) {
	if err := o.run(name, work); err != nil {
		log.Fatal(err)
	}
}

func (o Options) run(name string, work func(context.Context) error) error {
	if *o.duration < 0 {
		return fmt.Errorf("duration must be non-negative")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *o.duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *o.duration)
		defer cancel()
	}
	if *o.pprof != "" {
		listener, err := net.Listen("tcp", *o.pprof)
		if err != nil {
			return err
		}
		server := &http.Server{ReadHeaderTimeout: 5 * time.Second}
		defer server.Close()
		go func() {
			if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
				log.Printf("pprof: %v", err)
			}
		}()
		fmt.Printf("pprof: http://%s/debug/pprof/\n", listener.Addr())
	}
	closeAgent := peak.Start()
	defer closeAgent()
	fmt.Printf("%s: pid=%d duration=%s (Ctrl-C or Peak Stop to finish)\n", name, os.Getpid(), *o.duration)
	if err := work(ctx); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	fmt.Printf("%s: finished\n", name)
	return nil
}

// Wait is an interruptible delay, also used between workload phases.
func Wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
