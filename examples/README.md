# Go demos for Peak

These are real workloads for the desktop app, built with Go 1.27 and only the
standard library. Each runs for 60 seconds by default, prints progress, and handles
Ctrl-C, SIGTERM, and Peak's **Stop** button. `-duration 0` runs until stopped.

Run the following tasks from the repository root. Install Go 1.27, Task v3, and
the normal Peak development dependencies first. `go.mod` selects the Go 1.27
toolchain when Go's automatic toolchain selection is enabled.

```sh
task dev                  # keep the desktop app open in this terminal
```

In a second terminal, choose a demo:

```sh
task examples:cpu
task examples:memory
task examples:io
```

The tasks compile the demos first, then invoke `peak run -- ./bin/<demo>`.
That keeps Go compiler activity out of the workload's graphs. `PEAK_BIN` defaults
to the debug binary `task dev` builds; override it with an absolute path to another
Peak executable, such as an installed one (`PEAK_BIN=$HOME/.local/bin/peak`). Keep the desktop app open: Peak's CLI otherwise warns and runs the
command without monitoring.

| Demo | What to look for | Flags |
| --- | --- | --- |
| `cpu` | Three seconds of hashing on up to four goroutines, then two seconds idle. Compare CPU spikes, threads, and progress output. | `-workers 2` |
| `memory` | A retained cache grows by 4 MiB/s to 96 MiB, alongside 8 MiB of temporary allocations each second. Compare heap snapshots and GC events; retained blocks survive collection. | `-max-mib 64 -step-mib 2 -reset` |
| `io` | Write, sync, and checksum a 16 MiB temporary file once per second. Inspect I/O, open files, CPU, and logs. The file is overwritten and removed on normal exit or Stop. | `-file-mib 32` |

Customize run time with `DURATION`; pass workload flags after `--`:

```sh
task examples:cpu DURATION=30s -- -workers 2
task examples:memory DURATION=2m -- -max-mib 64 -step-mib 2
task examples:memory -- -reset
task examples:run DEMO=io DURATION=5s  # standalone, without Peak
```

You can also use **Capture a process** inside Peak. Set the working directory to
this repository's `examples` directory and the command to
`./bin/memory -duration 2m` (run `task examples:build` first). Use the binary,
without a nested `peak run`, when capturing inside the app.

## Peak's profiler

All three demos compile in the helper in `internal/demo`. When Peak supplies
`PEAK_AGENT_ADDR` and `PEAK_AGENT_TOKEN`, the helper connects to its existing
runtime-agent protocol and enables:

- Live Go heap usage and capacity, sampled every 500 ms.
- Completed GC events and pause durations. Go collections appear as major GC;
  freed bytes are an estimate over each polling interval.
- **Take snapshot**, including sampled live allocation stacks.
- **Collect garbage**, which calls `runtime.GC()`.

Try `task examples:memory DURATION=2m`. Select it in Peak, open **Profiler**, take
a snapshot after a few seconds, wait another five seconds, then take another.
`main.growCache` should grow in the table and allocation flame graph. **Collect
garbage** cannot reclaim the cache while the program still references it. Add
`-reset` to release the cache at its cap and show a repeating growth/release cycle.

Go's public heap profile samples allocation sites rather than enumerating object
types. For these demos, Peak's constructor/type rows contain **allocating function
names**, object counts are estimates, and shallow/retained columns both contain
estimated in-use bytes. They are not dominator retained sizes. Snapshots finish
two GC cycles to refresh the runtime memory profile, so capturing affects the
workload. This helper enables profiling for these examples; arbitrary Go binaries
do not get a Go agent injected automatically.

Heap size and RSS need not fall together: Go can keep freed pages for reuse.
The memory demo's `-reset` mode explicitly returns idle pages to the OS. The I/O
graph includes reads served from the OS page cache, so it demonstrates process I/O
rather than physical-device throughput.

## Native Go profiles

Start a demo through Peak with an additional pprof endpoint:

```sh
task examples:profile DEMO=memory DURATION=2m
# Or: task examples:profile DEMO=cpu DURATION=2m -- -workers 2
```

While it runs, use another terminal to capture profiles (`curl` is required):

```sh
task examples:pprof:heap
task examples:pprof:cpu PROFILE_SECONDS=10
task examples:pprof:goroutines
```

These tasks save profiles under `examples/profiles/` and print a `go tool pprof
-top` report. Repeated captures overwrite the corresponding file. For interactive
inspection, run `go tool pprof -http=127.0.0.1:8080 examples/profiles/heap.pb.gz`
(the graph view requires Graphviz). These files are for Go tooling; Peak's in-app
snapshots come through the helper described above.

The pprof server is disabled by default. The profile task enables it at
`127.0.0.1:6060`; set `PPROF_ADDR` consistently on the run and capture tasks to use
another port. Run one demo per port. Endpoint details follow Go's
[pprof documentation](https://pkg.go.dev/net/http/pprof).

## Checks

```sh
task examples:check
```

This checks formatting, runs `go vet`, and tests the real socket handshake,
snapshot/GC replies, streamed statistics, sampling correction, stack aggregation,
and disconnect cleanup with Go's race detector.
