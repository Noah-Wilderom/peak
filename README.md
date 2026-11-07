# Peak

Process monitoring and heap profiling in a Tauri desktop app, locally and on other
machines and containers over your own SSH, Docker and Kubernetes access.

## Install

Download from the [releases page](https://github.com/Noah-Wilderom/peak/releases). You don't need Bun or Rust.

| Platform | Download | Then |
|---|---|---|
| Linux x86_64 | `install.sh` or the `.AppImage` | `curl -fsSL https://github.com/Noah-Wilderom/peak/releases/latest/download/install.sh \| sh` puts it at `~/.local/bin/peak` with a menu entry. AppImages need `libfuse2` (Ubuntu 24.04: `sudo apt install libfuse2t64`) |
| Linux, Debian or Ubuntu | `.deb` | `sudo apt install ./peak_*_amd64.deb`. This one doesn't update itself |
| Windows x64 | `*_x64-setup.exe` | Run it. No admin needed. It adds `peak-cli` to your PATH for new terminals |
| macOS Apple Silicon or Intel | `*_aarch64.dmg` or `*_x64.dmg` | Drag Peak to Applications. For the command line: `ln -s /Applications/peak.app/Contents/MacOS/peak ~/.local/bin/peak` |

**Linux needs a desktop system.** The AppImage carries WebKit and GTK, but uses your system's graphics and font libraries, as any desktop has. On a bare server or in a minimal container even `peak version` fails with `error while loading shared libraries`. On Debian or Ubuntu, this installs them: `sudo apt install libegl1 libgl1 libx11-xcb1 libx11-6 libdrm2 libexpat1 libfontconfig1 libfreetype6 libfribidi0 libgbm1 libharfbuzz0b libwayland-client0 libxcb1`.

**Windows and macOS will warn you the first time.** This release isn't code-signed by Apple or Microsoft, so:

- **Windows:** SmartScreen says it "protected your PC". Choose **More info**, then **Run anyway**. If Smart App Control is on, Windows 11 blocks it with no way to allow just this app.
- **macOS:** it's reported as unverified, or as damaged. Try opening it once, then go to **System Settings > Privacy & Security** and choose **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/peak.app`.

Updates are separately signed, and Peak refuses any update that doesn't match its key.

Use it the same way everywhere: open the app, then run `peak run -- <command>` in a terminal (`peak-cli run -- <command>` on Windows). `peak version` says which version and format you have.

**Updates.** Peak looks for a new release on start and every 6 hours, and offers it. It only downloads when you say so, checks the signature, and only restarts when you say so. A restart stops commands the app itself started, and it names them first. Commands from `peak run` and attached processes keep running, and your history and settings stay.

| Format | Updates itself |
|---|---|
| Linux AppImage (`install.sh`) | Yes, in place |
| Windows installer | Yes |
| macOS app | Yes |
| Linux `.deb` | No: install the next `.deb` |
| Built from source | No |

**Already built Peak from source?** That copy never updates. Install once as above and it replaces `~/.local/bin/peak`. If you moved your copy somewhere else on your PATH, delete it or `peak` may keep running the old one; the installer warns if it finds one first. Your history and settings are in the same place, so they carry over.

### What works on each platform

| | Linux x86_64 | Windows x64 | macOS |
|---|---|---|---|
| Capture a command, memory, CPU, disk rate, output, exit | Yes | Yes | Yes |
| `peak run` to the open app | Yes | Yes, as `peak-cli` | Yes |
| Node and Python runtime agents | Yes | Yes | Yes |
| CPU split into user and system, threads, page faults | Yes | Yes | Yes |
| Memory composition (anonymous, file, shared), swap per process | Yes | No | No |
| File and socket handle counts, listening ports | Yes | No: shown as not tracked | No: shown as not tracked |
| Stopping a command lets it clean up | Yes | Only if it has a window | Yes |
| Memory pressure (PSI) | Yes | No | No |
| Load average | Yes | No: left out | Yes |
| Remote targets (SSH, Docker, Kubernetes on Linux machines) | Yes | Built in, not yet validated live | Built in, not yet validated live |

The Windows and macOS columns say what's built. [`docs/RELEASING.md`](docs/RELEASING.md) says what each has actually been run on.

## Getting started

You need [Bun](https://bun.sh), [Task](https://taskfile.dev), Rust through
[rustup](https://rustup.rs) and [Tauri's Linux system libraries](https://tauri.app/start/prerequisites/). Then:

```sh
task dev
```

That installs dependencies, builds everything and opens the app for development. The first build takes a few minutes.

**Which Peak is which:**

| You ran | What you get |
|---|---|
| An installed release | The real app. It monitors real processes, works with `peak run`, and updates itself |
| `task dev` | The real app, built from your checkout, for working on Peak. It doesn't update itself |
| `bun run dev` | **A browser demo with simulated data.** It has no real processes, and `peak` commands can't connect to it |

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

### How `peak run` finds the app

Any `peak` binary finds any open Peak app of the same user on the same machine, from any directory. With no app, your
command still runs, with its usual output and exit code, and `peak` says why it isn't being monitored:

| `peak` says | What it means |
|---|---|
| `the app isn't running on <host> for <user>` | No open app for that user on that machine. Peak only listens on localhost, so an app on your laptop can't be reached from an SSH session or a container. Check the host and user shown |
| `the app is open (PID n) but isn't answering` | It's open but frozen or overloaded |
| `the app is open (PID n) but can't be reached at <address>` | It's open, but its port refused the connection |
| `a Peak app is recorded in another container or network namespace` | It's on this kernel, but this shell's localhost isn't the app's |
| `couldn't read <path>` | A record couldn't be read, and no open app was found. If it's left over, delete that file |
| `<n> Peak apps are open; this run is in the one with PID n` | The command is monitored. It goes to the app using the same data directory, otherwise the newest |

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
