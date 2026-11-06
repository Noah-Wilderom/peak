# Peak

Process monitoring and heap profiling in a Tauri desktop app, locally and on other
machines and containers over your own SSH, Docker and Kubernetes access.

## Getting started

You need [Bun](https://bun.sh), [Task](https://taskfile.dev), Rust through
[rustup](https://rustup.rs) and [Tauri's Linux system libraries](https://tauri.app/start/prerequisites/). Then:

```sh
task dev
```

That installs dependencies, builds everything and opens the app for development. The first build takes a few minutes.

### The `peak` command

Building doesn't put `peak` on your PATH. To open Peak without a dev server, or to use `peak run` from anywhere:

```sh
task peak:build                                    # optimized build; about 5 minutes the first time
./src-tauri/target/release/peak                    # opens the app
./src-tauri/target/release/peak run -- npm test    # with the app open, monitors that command
```

To have a bare `peak` command, install it:

```sh
task peak:install        # builds, then copies it to ~/.local/bin/peak
```

Set `PEAK_INSTALL_DIR` to choose another directory. Peak never edits your shell profile. If the directory isn't on your
PATH, the task says so and shows the line to add. The installed app still needs Tauri's Linux system libraries.

`task dev` also leaves a binary at `src-tauri/target/debug/peak`. Its CLI works, but its window loads from the dev
server, so it stays blank on its own.

### Remote targets, in brief

To monitor Docker containers, Kubernetes pods or SSH hosts, Peak copies a small static collector to the target.
**You don't need to build or install it:** it's built into the app, using a Rust target that `rustup` adds on the
first build. `peak collector` shows where it is. Details and limits are under [Remote targets](#remote-targets).

The [Go 1.27 examples](examples/README.md) demonstrate CPU bursts, retained memory,
garbage collection, heap snapshots, and disk I/O. With Peak open, try
`task examples:memory`. Run `task --list` to see the available demo and profiling
tasks.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Remote targets

The collector is embedded for the architecture Peak was built on: `x86_64-unknown-linux-musl` on a typical machine.
It's static, so it doesn't depend on the target's libc. It needs an x86-64 Linux target and somewhere it can be copied
and run (`/tmp` in containers).

- **A target of another architecture** reports that no build is available for it. Put a static build at
  `$PEAK_COLLECTORS/<arch>/peak-collector`, or prepare it on the target.
- **A locked-down container** (read-only, stopped, or blocking execution) reports why it couldn't connect. Docker's
  container totals, process list and logs need no collector, so they still work.
- **A build that couldn't embed one** (no rustup, and no musl target) still runs locally with a build warning, and
  remote targets say so. Release builds refuse to build this way unless you set `PEAK_ALLOW_NO_COLLECTOR=1`.

Installers carry the collector inside the app binary, so they need no extra files.

## Tests

| Suite | Command | What it covers |
|---|---|---|
| Frontend | `bun run test:coverage` | Vitest + Testing Library over all of `src/` (100% enforced) |
| Backend | `cd src-tauri && cargo llvm-cov --workspace --ignore-filename-regex '(lib\|main\|live_\w+)\.rs$'` | `/proc` parsing, sampling, runner, monitor, hub, CLI, collector, targets (≥99% enforced) |
| Agents | `bun run test:agents` | The injected Node and Python profiling agents, end to end |
| Live remote | `task test:live` | Real SSH, Docker and Kubernetes against disposable local environments (not in CI) |
| Clean start | `scripts/verify-clean-start.sh <dir> <log>` | `task dev` from an exported copy with nothing prepared (not in CI) |
| Real UI | `scripts/e2e/` | Real browser against the mock; the real desktop binary in a disposable container |

`bun run typecheck`, `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`
also run in CI — see `.github/workflows/test.yml`.

Outside Tauri (plain `bun run dev` in a browser) the UI runs against a simulated
monitor (`src/lib/mock.ts`); inside the desktop app it uses the Rust backend.

## Wayland known issues

Run with this command to avoid a crash on Wayland:

```bash

__NV_DISABLE_EXPLICIT_SYNC=1 bun run tauri dev
```

## Docs

- [Handoff: current state and next steps](docs/HANDOFF.md)
- [Remote monitoring: what's validated, and what isn't](docs/REMOTE-VALIDATION.md)
- [Remote monitoring research](docs/remote-monitoring-research.md)
