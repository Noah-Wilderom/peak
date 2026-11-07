# Peak agent for Go

Reports a Go program's heap, garbage collections and scheduler latency to [Peak](https://github.com/Noah-Wilderom/peak), and answers CPU profile, heap profile and forced-collection requests from it. Standard library only.

A compiled program can't have anything injected into it, so it opts in with one import:

```go
import _ "github.com/Noah-Wilderom/peak/sdk/go/auto"
```

or, to choose when it starts and stops:

```go
stop := peak.Start()
defer stop()
```

Then run it through Peak, with the Capture page or:

```sh
peak run -- ./yourprogram
```

Outside Peak, `Start` returns straight away and does nothing, so it's safe to leave in.

## Getting it

```sh
go get github.com/Noah-Wilderom/peak/sdk/go@latest
```

Or without downloading anything: each Peak release includes a matching copy, and `peak agents` prints where it is and how to build against it.

Needs Go 1.21 or newer.

## What's measured

| Peak shows | Source | Meaning |
| --- | --- | --- |
| Heap | `runtime.MemStats` | `HeapAlloc`, of `HeapSys` |
| Garbage collections | `MemStats.PauseNs` | Stop-the-world pause. Bytes freed are estimated from allocation counters |
| Runtime delay | `/sched/latencies:seconds` | p99 time goroutines waited to be scheduled |
| CPU profile | `runtime/pprof` | On-CPU time for all goroutines. Blocked goroutines don't appear |
| Heap snapshot | `runtime.MemProfile` | Sampled allocation sites, scaled the way `pprof` does. No type names or retained sizes, which Go doesn't expose |
| Goroutines, time in GC, live objects | `runtime` | Latest values |

A snapshot runs two collections first, so that the profile is current. A program that's already recording its own CPU profile can't record a second one, and Peak reports that as an error.
