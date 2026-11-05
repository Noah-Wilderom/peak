// CPU demonstrates bursts across a bounded worker pool followed by idle gaps.
package main

import (
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"peak/examples/internal/demo"
)

func main() {
	opts := demo.Flags()
	workers := flag.Int("workers", min(4, runtime.NumCPU()), "concurrent hashing workers")
	flag.Parse()
	if *workers < 1 || *workers > 256 {
		panic("workers must be between 1 and 256")
	}
	opts.Run("cpu", func(ctx context.Context) error {
		for round := 1; ctx.Err() == nil; round++ {
			fmt.Printf("round %d: hashing for 3s with %d workers\n", round, *workers)
			burst, cancel := context.WithTimeout(ctx, 3*time.Second)
			var total atomic.Uint64
			var wg sync.WaitGroup
			for i := 0; i < *workers; i++ {
				wg.Add(1)
				go func(seed byte) {
					defer wg.Done()
					total.Add(hashBatch(burst, seed))
				}(byte(i))
			}
			wg.Wait()
			cancel()
			fmt.Printf("round %d: %d hashes; cooling down for 2s\n", round, total.Load())
			if !demo.Wait(ctx, 2*time.Second) {
				break
			}
		}
		return nil
	})
}

func hashBatch(ctx context.Context, seed byte) uint64 {
	data := make([]byte, 32*1024)
	for i := range data {
		data[i] = seed + byte(i)
	}
	var count uint64
	for ctx.Err() == nil {
		sum := sha256.Sum256(data)
		data[count%uint64(len(data))] = sum[0]
		count++
	}
	runtime.KeepAlive(data)
	return count
}
