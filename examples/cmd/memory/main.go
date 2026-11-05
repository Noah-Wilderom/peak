// Memory contrasts a deliberately retained cache with collectible scratch data.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"time"

	"peak/examples/internal/demo"
)

func main() {
	opts := demo.Flags()
	limit := flag.Int("max-mib", 96, "maximum retained cache size in MiB")
	step := flag.Int("step-mib", 4, "cache growth per second in MiB")
	reset := flag.Bool("reset", false, "release the cache at the limit, then grow again")
	flag.Parse()
	if *limit < 1 || *limit > 1024 || *step < 1 || *step > *limit {
		fmt.Fprintln(os.Stderr, "require 1 <= step-mib <= max-mib <= 1024")
		os.Exit(2)
	}
	opts.Run("memory", func(ctx context.Context) error {
		var cache [][]byte
		var retained int
		warned := false
		for tick := 1; ctx.Err() == nil; tick++ {
			if retained < *limit {
				size := min(*step, *limit-retained)
				cache = append(cache, growCache(size<<20))
				retained += size
			} else if *reset {
				cache = nil
				retained = 0
				// Return idle pages to the OS so RSS can fall as well as heap usage.
				debug.FreeOSMemory()
				fmt.Println("cache released; heap and RSS should fall")
			} else if !warned {
				fmt.Fprintln(os.Stderr, "demo warning: cache reached its cap; GC cannot free these referenced blocks")
				warned = true
			}
			checksum := churnScratch()
			fmt.Printf("tick %d: retained cache=%d MiB, scratch checksum=%d\n", tick, retained, checksum)
			if !demo.Wait(ctx, time.Second) {
				break
			}
		}
		runtime.KeepAlive(cache)
		return nil
	})
}

// Separate allocation functions make the profiler's stacks easy to recognize.
//
//go:noinline
func growCache(size int) []byte {
	block := make([]byte, size)
	for i := range block {
		block[i] = byte(i + 1)
	}
	return block
}

//go:noinline
func churnScratch() byte {
	blocks := make([][]byte, 8)
	var checksum byte
	for i := range blocks {
		blocks[i] = make([]byte, 1<<20)
		for j := range blocks[i] {
			blocks[i][j] = byte(i + j)
		}
		checksum ^= blocks[i][len(blocks[i])-1]
	}
	runtime.KeepAlive(blocks)
	return checksum
}
