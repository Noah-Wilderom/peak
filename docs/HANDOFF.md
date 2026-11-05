# Peak — handoff

_Last updated 2026-11-06._ Peak is a local process monitor and memory profiler for
development: run or attach to a process, then watch memory, CPU, I/O, GC and heap
contents live. Tauri 2 + React 19 + shadcn/ui + recharts + motion, Rust backend,
Linux first (`/proc`). The UI follows `DESIGN.md` (monochrome, pill controls),
plus semantic colour for status and a dark mode.

The directory is **not a git repository yet**; nothing has been committed or pushed.

## State at handoff

Everything below passes locally, exactly as CI runs it:

| Check | Result |
|---|---|
| `bun run typecheck` | clean |
| `bun run test:coverage` | 74 tests, **100%** statements/branches/functions/lines (enforced in `vitest.config.ts`) |
| `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo llvm-cov --ignore-filename-regex '(lib\|main)\.rs$'` | 67 tests, **99.67%** lines (CI gate: 99%) |
| `bun run test:agents` | Node 3/3, Python 5/5 |
| `bun run build` | ok |

CI: `.github/workflows/test.yml`, with jobs for the frontend, the backend (installs the Tauri system libraries and builds the frontend first, because `generate_context!` embeds it) and the agents (Node 20 and 22, plus Python).

### Done and wired end-to-end

- **Live monitoring.** The backend samples each tracked process tree from `/proc` every 500ms and pushes `peak://tick`. The UI never polls. Captured per sample:
  - RSS and its composition
  - CPU user/sys
  - I/O, faults, context switches
  - FDs, threads, swap
- **Process lifecycle.** Run a command (own process group, stdout/stderr captured), attach to an existing PID, stop (SIGINT → SIGKILL after 3s), restart, remove, clear. Processes peak spawned are terminated on app exit.
- **Runtime agents** (`src-tauri/agents/`). Injected via `NODE_OPTIONS=--require` and `PYTHONPATH/sitecustomize.py`. They report heap stats and GC events, and answer `snapshot` (heap by type + allocation-site tree) and `gc` requests over the hub socket.
- **`peak run -- <cmd>` CLI.** Same binary. Tees output to the terminal and streams it to the running app via `~/.local/share/peak/control.json`.
- **UI:**
  - Overview: tiles, memory/CPU/IO charts
  - Memory: composition, trend/leak verdict, percentiles, GC, allocation rate, faults, distribution
  - Profiler: snapshots, treemap, flame graph, diff, likely-leak
  - Stats, Output, Processes
  - Capture page, which doubles as the empty state
  - Time ranges 30s–1h, drag-to-zoom, elapsed/clock axis, synced crosshairs, smooth gliding charts
  - Live byte hover cards, click-to-copy PID, dark mode
- **Browser mock** (`src/lib/mock.ts`). `bun run dev` in a plain browser simulates a realistic fleet, so the UI can be worked on without Tauri.

### Built in the backend this session, not yet surfaced in the UI

The Rust side is implemented and tested. The frontend only received the minimal type and contract updates needed to keep working.

| Capability | Backend pieces | Frontend status |
|---|---|---|
| **SQLite persistence** | `db.rs` (bundled rusqlite, WAL) stores runs, samples, logs, GC, snapshots and CPU profiles. `service.rs` persists every tick, closes runs cut off by a crash, and applies retention every 10 min. DB at `~/.local/share/peak/peak.db`. | No UI. History survives restarts but can't be browsed yet. |
| **History / settings commands** | `list_runs`, `open_run`, `load_run`, `delete_run`, `prune_runs(older_than_days?)`, `storage_info`, `vacuum`, `get_settings`, `set_settings` (in `lib.rs`). `Settings` = retention days, max runs, alert thresholds, notifications. | Not in `MonitorApi`, the mock or the UI. |
| **Machine context** | `SystemSampler`: memory, swap, PSI memory pressure, load1, total CPU. Sent as `TickPayload.system`. | Stored in `State.machine` (bounded); nothing renders it. |
| **Resources** | `Sample.threads/files/sockets/pipes`, per-child `Sample.kids`, `Proc.childNames`, listening `Proc.ports` (`/proc/net/tcp{,6}` joined by socket inode) | Types only (optional fields). |
| **Runtime lag** | `Sample.loopLag` from agent `heap.loopLag` or a new `{"type":"lag","loopLag":ms}` message | **Agents don't send it yet.** Types only. |
| **CPU profiling** | `cpu_profile(id, ms)` command → hub sends `{"cmd":"cpuprofile","ms":N}` → expects reply `data: {durationMs, root: AllocFrame}` where `self` = ms on-CPU. Stored on the run and in the DB. | **Agents don't implement it yet.** No UI. |

## Next steps (in order)

1. **Agents** (small, unblocks two features):
   - Node: `perf_hooks.monitorEventLoopDelay()` p99 → `loopLag` in the existing heap message. For `cpuprofile`: `Profiler.enable/setSamplingInterval/start` → wait `ms` → `Profiler.stop`, then convert nodes/hitCount to an `AllocFrame` tree.
   - Python: a lag thread (sleep 10ms, measure oversleep, p99 per 500ms) sending `type: "lag"`. For `cpuprofile`: sample `sys._current_frames()[main]` every ~5ms and build the tree.
   - Extend `agents/tests/*`.
2. **History page.** Runs from `list_runs` grouped by command, with search, open (`open_run` puts the run back in the session), delete, and multi-select for compare. Add the methods to `MonitorApi`, `TauriMonitor` and `MockMonitor` (mock: seed past runs in memory).
3. **Settings page.** Retention days and max runs, prune actions (older than N days / all stopped runs / vacuum), storage info, alert thresholds, notifications toggle. Move the theme toggle here too.
4. **Run comparison.** Overlay two runs' memory curves aligned at T+0, with peak, duration and avg-CPU deltas (`load_run` fetches without adding to the session).
5. **Run report tab.** Verdict, peak, duration, exit, GC share, top allocators (latest snapshot), alerts. Copy as Markdown/JSON.
6. **Timeline markers + click-to-logs.** stderr lines, major GCs, snapshots and alerts drawn on the memory chart. A click (drag shorter than 4 ticks in `useTimelineChart`) jumps to the Output tab at that time.
7. **Alerts engine** (frontend, using `Settings`): memory above X MiB; CPU above Y% for Z seconds. Toast, native notification (`tauri-plugin-notification`), and a timeline marker.
8. **Resources tab** (replaces Processes): per-child stacked memory from `Sample.kids`, threads and handles over time, ports list, child table. Show runtime lag here as well.
9. **Machine strip** in the sidebar, plus a machine chart, from `State.machine`. This tells "my process is big" apart from "the box is starved".
10. **CPU profile UI** in the Profiler tab: record 5s/10s and render with `FlameGraph`. It needs a value-formatter prop for ms instead of bytes.
11. **Remote monitoring.** Follow [`docs/remote-monitoring-research.md`](remote-monitoring-research.md):
    - Introduce a **target model** (local / SSH / Docker / Kubernetes) with capabilities and connection state.
    - Extract a Tauri-independent core crate and a **headless collector binary** speaking a versioned stdio protocol.
    - Start with a **read-only SSH observation spike**, then Docker discovery/observation, then Kubernetes, then remote launch/control/profiling.
    - The doc's "correct behavior to preserve" list should be treated as requirements: identity, disconnect ≠ exit, target-local time, no fabricated metrics, routed signals.

## Map

```
src-tauri/src/
  procfs.rs    /proc parsers + ProcFs (rootable at a fixture dir for tests)
  sampler.rs   TreeSampler (rates, totals, composition), SystemSampler
  runner.rs    spawn via /bin/sh -c in own pgid, output pump, exit classification, signals
  monitor.rs   Monitor: tracked runs, per-tick deltas (TickPayload), pending DB writes, agent hooks
  hub.rs       localhost JSON-lines socket for agents + `peak run` CLI; agent install; control file
  db.rs        SQLite schema, writes, history queries, retention, settings
  service.rs   monitor + hub + db wiring (tick → persist → retention); Tauri commands call this
  cli.rs       `peak run -- <cmd>`
  lib.rs       Tauri commands/events (thin), app setup, tick thread
  model.rs     serde types shared with src/lib/types.ts (camelCase)
src-tauri/agents/   peak-agent.cjs, python/sitecustomize.py, tests/
src/lib/      types, monitor-api (interface), monitor (picks backend), tauri-monitor, mock,
              series (windowing/ticks/stats), analysis (trend/GC/diff), format, ramp, theme
src/hooks/    use-monitor, use-smooth (shared rAF clock, gliding time domain, tweens), use-theme
src/components/  views (process-detail, memory-tab, profiler-tab, stats-tab, capture-page, ...)
                 charts/ (timeline context + charts), ui/ (shadcn, excluded from coverage)
```

**Frontend/backend contract.**
- `get_state` gives the full state at startup.
- `peak://tick` then carries `{ procs: ProcDelta[], system }`; `peak://proc` announces processes registered by the CLI.
- `applyDelta` skips overlap by sample `t`, log `id` and GC `t`.
- Processes are normalized to always have ≥1 sample (`normalizeProc`). The backend also takes a first sample on insert.

## Gotchas

- **Units are binary.** `formatBytes` prints KiB/MiB/GiB (1024 steps). The hover card shows both binary and decimal.
- **jsdom layout mock** (`src/test/setup.ts`) gives elements 800×300 and legends 200×20. Without it recharts renders nothing. Without the legend override, the legend fills the plot and tooltips never activate.
- **Recharts handles pointer events on the next animation frame.** Tests wait ~40–60ms after each `fireEvent`.
- **Live charts at the 30s range re-render ~40fps**, which is slow in jsdom. The App walkthrough test switches to `1h` early.
- **Coverage is 100% and enforced.** New frontend code needs tests. Prefer removing unreachable defensive branches over excluding them.
- **Spawned children must not inherit ignored signals.** `runner::reset_signals` runs in `pre_exec`. Without it, Stop silently falls back to SIGKILL.
- **Monitor lock scope.** `Service::tick` holds the monitor lock while reading `/proc` for all runs. Fine locally; keep remote I/O outside it (see the research doc).
- **Agent tokens are run ids**, so the hub must stay localhost-only.
- **Bun processes don't get the Node agent** (Bun ignores `NODE_OPTIONS --require`). They get OS metrics only.
- **Parallel work.** Another session added Go demo workloads (`examples/`), a `Taskfile.yml` and README changes that use `peak run`. They're independent of the above, and `examples/bin/` holds built binaries.

## Commands

```sh
bun install
bun run tauri dev            # desktop app (or: task dev)
bun run dev                  # browser + mock monitor at http://localhost:1420
bun run test:coverage        # frontend
bun run test:agents          # Node + Python agents
cd src-tauri && cargo test   # backend; coverage: cargo llvm-cov --ignore-filename-regex '(lib|main)\.rs$'
```
