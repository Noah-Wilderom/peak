# Peak

Local process monitoring and heap profiling in a Tauri desktop app.

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
| Backend | `cd src-tauri && cargo llvm-cov --ignore-filename-regex '(lib\|main)\.rs$'` | `/proc` parsing, sampling, runner, monitor, hub, CLI (≥99% enforced) |
| Agents | `bun run test:agents` | The injected Node and Python profiling agents, end to end |

`bun run typecheck`, `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`
also run in CI — see `.github/workflows/test.yml`.

Outside Tauri (plain `bun run dev` in a browser) the UI runs against a simulated
monitor (`src/lib/mock.ts`); inside the desktop app it uses the Rust backend.
