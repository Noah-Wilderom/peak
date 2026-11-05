// IO repeatedly overwrites and reads one bounded temporary file.
package main

import (
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"peak/examples/internal/demo"
)

func main() {
	opts := demo.Flags()
	size := flag.Int("file-mib", 16, "temporary file size in MiB")
	flag.Parse()
	if *size < 1 || *size > 1024 {
		fmt.Fprintln(os.Stderr, "file-mib must be between 1 and 1024")
		os.Exit(2)
	}
	opts.Run("io", func(ctx context.Context) error {
		file, err := os.CreateTemp("", "peak-io-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		defer file.Close()
		fmt.Printf("temporary file: %s (removed on exit)\n", file.Name())
		buf := make([]byte, 1<<20)
		for i := range buf {
			buf[i] = byte(i)
		}
		for round := 1; ctx.Err() == nil; round++ {
			if _, err := file.Seek(0, io.SeekStart); err != nil {
				return err
			}
			for i := 0; i < *size && ctx.Err() == nil; i++ {
				if _, err := file.Write(buf); err != nil {
					return err
				}
			}
			if ctx.Err() != nil {
				break
			}
			if err := file.Sync(); err != nil {
				return err
			}
			if _, err := file.Seek(0, io.SeekStart); err != nil {
				return err
			}
			hash := sha256.New()
			if _, err := io.CopyBuffer(hash, file, buf); err != nil {
				return err
			}
			fmt.Printf("round %d: wrote and read %d MiB, sha256=%x\n", round, *size, hash.Sum(nil)[:6])
			if !demo.Wait(ctx, time.Second) {
				break
			}
		}
		return nil
	})
}
