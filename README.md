# Peak

Process monitoring and heap profiling in a Tauri desktop app, locally and on other
machines and containers over your own SSH, Docker and Kubernetes access.

Run `task dev` to start the desktop app, or `task peak:build` to build the local
app and `peak run -- <command>` CLI.

The [Go 1.27 examples](examples/README.md) demonstrate CPU bursts, retained memory,
garbage collection, heap snapshots, and disk I/O. With Peak open, try
`task examples:memory`. Run `task --list` to see the available demo and profiling
tasks.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Tests

| Suite | Command | What it covers |
|---|---|---|
| Frontend | `bun run test:coverage` | Vitest + Testing Library over all of `src/` (100% enforced) |
| Backend | `cd src-tauri && cargo llvm-cov --workspace --ignore-filename-regex '(lib\|main\|live_\w+)\.rs$'` | `/proc` parsing, sampling, runner, monitor, hub, CLI, collector, targets (≥99% enforced) |
| Agents | `bun run test:agents` | The injected Node and Python profiling agents, end to end |
| Live remote | `task test:live` | Real SSH, Docker and Kubernetes against disposable local environments (not in CI) |
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
