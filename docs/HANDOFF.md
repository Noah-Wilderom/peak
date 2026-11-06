# Peak: handoff

_Last updated 2026-11-06._ Peak is a process monitor and memory profiler for development: run or attach
to a process, locally or on another machine or container, and watch memory, CPU, I/O, GC and heap contents
live. Tauri 2 + React 19 + shadcn/ui + recharts + motion, Rust backend, Linux first (`/proc`). The UI
follows `DESIGN.md` (monochrome, pill controls), plus semantic colour for status and a dark mode.

The original delivery is `dfa4dd3` on `origin/master`; `git log` has the current state. Progress and evidence:
[`DEVELOPMENT-STATUS.md`](DEVELOPMENT-STATUS.md). Acceptance criteria: [`ACCEPTANCE.md`](ACCEPTANCE.md).
Remote evidence and open gaps: [`REMOTE-VALIDATION.md`](REMOTE-VALIDATION.md).

## What exists

- **Live monitoring.** Samples each tracked process tree from `/proc` every 500ms and pushes `peak://tick`.
  The UI never polls.
- **Process lifecycle.** Run a command, attach to a PID, stop (SIGINT, then SIGKILL after 3s, identity-checked),
  restart, remove, clear. Processes peak spawned are terminated on app exit.
- **Runtime agents** (`src-tauri/agents/`). Injected via `NODE_OPTIONS=--require` and `PYTHONPATH`. Heap stats,
  GC events, snapshots, runtime lag, CPU profiles.
- **`peak run -- <cmd>`.** Tees output to the terminal and streams it to the running app.
- **Views.** Overview, Memory, Profiler (heap and CPU), Stats, Report, Output, Resources; History, Comparison,
  Settings, This machine, Targets; the capture page doubles as the empty state.
- **Persistence.** SQLite: runs, samples, logs, GC, snapshots, CPU profiles, alerts, settings, targets.
- **Alerts.** `src/lib/alerts.ts`, evaluated in the frontend store for both backends, recorded on the run.
- **Remote.** Targets for SSH, Docker and Kubernetes, a headless collector, a versioned protocol, and routed
  launch, control and profiling. See below.
- **Browser mock** (`src/lib/mock.ts`). `bun run dev` in a plain browser simulates a fleet, past runs and
  targets, all labelled as simulated.

## Map

```
src-tauri/                    workspace root; package `peak` is the desktop app
  peak-core/src/              no desktop dependencies; also runs on targets
    model.rs                  serde types shared with src/lib/types.ts (camelCase)
    procfs.rs  sampler.rs     /proc parsers; rates, totals, composition, machine sample
    runner.rs                 spawn (shell or direct argv), output pump, exit classification, signals
    monitor.rs                tracked runs, per-tick deltas, pending DB writes, agent hooks
    hub.rs                    localhost JSON-lines socket for agents and `peak run`; agent install
    cgroup.rs                 cgroup v1/v2 limits, labelled apart from host memory
    protocol.rs               collector protocol v1: requests, frames, facts
    collector.rs              one collector session over stdio; the disconnect contract
  peak-collector/             the headless binary: `serve`, `probe`, `version`
  build.rs                    builds the static collector and embeds it in the app
  src/
    bundled.rs                unpacks the embedded collector for transports to copy
    db.rs                     SQLite schema, history, retention, settings, targets
    remote.rs                 targets, sessions, reconnect, dedupe, gaps, routing
    transport.rs              ssh/docker/kubectl commands, collector install, discovery parsers
    service.rs                monitor + hub + db + remote; Tauri commands call this
    cli.rs                    `peak run -- <cmd>`
    lib.rs                    Tauri commands/events (thin), app setup, tick thread
  tests/live_*.rs             live validation, #[ignore]d (see REMOTE-VALIDATION.md)
  agents/                     peak-agent.cjs, python/sitecustomize.py, tests/
src/lib/                      types, monitor-api (interface), monitor (picks backend), tauri-monitor, mock,
                              series, analysis, alerts, markers, history, compare, report, resources, machine,
                              notify, format, ramp, theme
src/hooks/                    use-monitor, use-smooth, use-theme
src/components/               views, charts/ (timeline context + charts), ui/ (shadcn, excluded from coverage)
scripts/e2e/                  real-browser and real-desktop walkthroughs
```

## Contracts

**Frontend/backend.** `get_state` gives the full state at startup: `{ procs, system, targets }`.
`peak://tick` carries `{ procs: ProcDelta[], system, targets? }`; `peak://proc` announces processes registered
by the CLI. `applyDelta` skips overlap by sample `t`, log `id` and GC `t`. Processes always have ≥1 sample.

**Collector protocol** (`peak-core/src/protocol.rs`, version 1). JSON lines over stdio. Stdout carries only
frames; diagnostics go to stderr. Requests carry `req`; replies echo it. `Tick` frames carry `seq`; a gap asks
for `Resync`, and what's aged out of the buffer is recorded as a gap. Frames over 64 MiB are refused.

**Run identity.** Remote run ids are `<target>~<collector run>`, and stay the same across reconnects. Identity
is boot id + PID namespace + PID + start ticks, plus container id or pod UID.

**Connection vs status.** `TargetState.state` (connecting/connected/stale/disconnected/failed) is independent of
`Proc.status`. Unknown endings use `signal` values with `exit_code: None`: `ended while disconnected`,
`target rebooted`, `monitoring stopped`, `stopped with the session`, `peak closed`.

**CPU profiles** carry `sampling`. Neither method is strict on-CPU time, and the UI says so: `v8` shows loop waits
as `(idle)` but charges synchronous blocking to the caller; `stack` samples on a timer whether running or not.

## Gotchas

- **Units are binary.** `formatBytes` prints KiB/MiB/GiB. The hover card shows both binary and decimal.
- **jsdom layout mock** (`src/test/setup.ts`) gives elements 800×300 and legends 200×20. Without it recharts renders nothing.
- **Recharts handles pointer events on the next animation frame.** Tests wait ~40-60ms after each `fireEvent`.
- **Don't use async `act()` to wait in App tests.** While charts animate it can never drain, and under coverage
  renders outlast frames. `App.test.tsx` has a `sleep` helper, freezes the gliding clock and skips motion.
- **Coverage is enforced:** 100% frontend, ≥99% backend lines. Prefer removing unreachable branches over excluding them.
- **Spawned children must not inherit ignored signals.** `runner::reset_signals` runs in `pre_exec`.
- **`Monitor` lock scope.** `tick` holds it while reading `/proc`. Remote I/O never goes near it.
- **`now_ms()` is anchored once and advanced monotonically,** so clock changes don't break rates. `wall_ms()` reads the clock.
- **Hub tokens are run ids**, so the hub stays localhost-only, on whichever machine it runs.
- **Serde and internally tagged enums:** integer map keys fail through them (`ServerFrame`), so `child_names` uses strings.
- **`kubectl auth can-i` needs `--subresource`:** `pods/log` would ask about a pod named `log`.
- **OpenSSH reads `~/.ssh` from the passwd entry,** not `$HOME`.
- **V8 attribution:** code optimized on-stack before a profile starts is charged to its caller. Totals stay right.
- **Bun processes don't get the Node agent.** They get OS metrics only.
- **WebKitGTK hard-codes helper paths,** so the desktop window can't run from a rootless extraction. Use the container in `scripts/e2e/desktop/`.
- **k3s evicts below 5% free disk,** and this machine's Docker disk is near that. New pods then stay Pending. The disposable clusters relax the threshold.
- **`import sitecustomize` isn't reliable in tests.** Python imports that name at startup, and Ubuntu's Python ships its own. The agent tests load it by path.
- **The collector is built by a nested cargo in `build.rs`.** It clears the outer build's settings, because coverage works through `RUSTC_WRAPPER`, which would otherwise break it. It builds into `target/embedded-collector`. Without CI's `PEAK_REQUIRE_COLLECTOR=1`, a debug build that can't embed one only warns, and its embedded-collector tests are compiled out.
- **Targets aren't re-copied within a version.** The readiness check compares collector version and protocol, so while changing the collector without bumping them, a target keeps its old copy until that file is removed.
- **`target/debug/peak` isn't a standalone app.** A plain debug build's window loads from the dev server, so it's blank without one; its CLI works. `tauri build` embeds the frontend. `scripts/verify-install.sh` checks the documented build and install steps.
- **`rustfmt` reshapes code,** so scripted edits can silently miss. Check they applied.
- **The notification plugin can't report delivery on Linux:** permission is always "granted" and errors are discarded.
- **A drag across too little data is neither a zoom nor a click.** `useTimelineChart` checks how far the pointer moved.
- **Short windows.** `1s` and `10s` live in `RANGES` with the rest. Sampling is still 500ms, so a 1s window holds 2 or 3 real samples. While the pointer is pressed, `TimelineProvider` holds every chart's range and data, or a live 1s drag couldn't land. On a live 1s chart a resting tooltip can blank briefly, because recharts tracks the array position, not the pointer. Details are in `DEVELOPMENT-STATUS.md`.

## Commands

```sh
bun install
task dev                     # desktop app for development
task peak:build              # optimized app at src-tauri/target/release/peak; PATH unchanged
task peak:install            # that, copied to ~/.local/bin/peak or PEAK_INSTALL_DIR
bun run dev                  # browser + mock monitor at http://localhost:1420
src-tauri/target/debug/peak collector   # which collector this build copies to targets

bun run typecheck
bun run test:coverage        # frontend (100% enforced)
bun run test:agents          # Node + Python agents
cd src-tauri && cargo test --workspace
cd src-tauri && cargo llvm-cov --workspace --ignore-filename-regex '(lib|main|live_\w+)\.rs$' --fail-under-lines 99
task test:live               # live SSH, Docker, Kubernetes against disposable environments
scripts/e2e/desktop/run.sh   # the real desktop binary with real backends, in containers (see its header)
PEAK_TOOLS=<dir> scripts/verify-all.sh   # all of the above and the browser walkthrough, with a dated log
```

Here, `PEAK_TOOLS=/mnt/HC_Volume_107248377/.peak-sysroot` holds the private webkit dev libraries, `kubectl`,
`tauri-driver`, Playwright and extra Node versions. Cargo commands need `. $PEAK_TOOLS/env.sh` first.

## What's next

All eleven planned steps are implemented and pass the checks in `scripts/verify-all.sh`. The build/launch fix and the 1s
and 10s chart windows are accepted and published as `5a1f57be524a0b7fcad2fb38838257a8f62e1419` (see
[`DEVELOPMENT-STATUS.md`](DEVELOPMENT-STATUS.md) for evidence and limits). What remains is outside what this machine could validate:

1. Close the live gaps in [`REMOTE-VALIDATION.md`](REMOTE-VALIDATION.md), starting with SSH to a real second machine.
2. Build and validate arm64. The collector already travels inside the app binary, including in installers.
3. Consider running `live_ssh` and `live_docker` in CI. They aren't in CI today.
