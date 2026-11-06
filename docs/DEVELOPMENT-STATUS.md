# Peak development status

Durable handover for PM checkpoints. Acceptance criteria: `docs/ACCEPTANCE.md`.
Remote evidence and open gaps: `docs/REMOTE-VALIDATION.md`.

- **Last update:** 2026-11-06 14:50 UTC
- **State:** the reproduced CLI/app-discovery defects are accepted and pushed as `a1defaa786fc1d1a1e3da836540368a1ddc78eda`. Reporter-specific confirmation follows update/retry.
- **PM delivery update:** 2026-11-06 14:56:54 UTC. CLI fix: `a1defaa786fc1d1a1e3da836540368a1ddc78eda` on `origin/master`; remote SHA verified and checkpoints disabled.
- **Commits:** the original delivery is committed and pushed: `origin/master` at `dfa4dd3befcdfc67a5131ce55ce3b67ce78a5876`. The collector fix is committed and pushed as `e7131b71298a07d5f51b3d40eb2e1b5b9aa5a047`.

## Accepted discovery fix: "the cli keeps saying the app isn't running while it is running"

**Status: accepted and pushed as `a1defaa786fc1d1a1e3da836540368a1ddc78eda`. The user's own failure hasn't been seen directly.** The exact command and launch method are still pending from the user.

**This host can't show the user's case.** It has no Peak process, `~/.local/share/peak` has no `control.json` or `peak.db`, and it has no system WebKit. So the user's app isn't running here under this account. I inspected read-only and touched nothing of theirs.

**Reproduction.** Unchanged `d1d67db`, a real app in a real window (container, Xvfb), and `peak run` started as separate processes with plain shell environments. Log: `docs/evidence/cli-discovery/1-reproduction-before-fix.log`, 14:04:33-14:07:11 UTC, nine failures. The ordinary path worked: `peak` on PATH, relative path, installed copy, other build's CLI, other directories. These failed:

| Scenario | What happened before the fix |
|---|---|
| A second Peak opens, then closes | **The closest match to the report.** It overwrites the single `control.json`, which then names a dead app. The first app stays open, and the CLI says "isn't running" until that app restarts |
| Shell with a different `XDG_DATA_HOME` | Looks in another directory: "isn't running" |
| Shell with `HOME` unset | Same |
| Record removed while the app is open | Same, until the app restarts |
| Corrupt record beside a healthy app | Same |
| Two apps open | Nothing says which one got the run |
| App frozen | "isn't running" |
| Only a corrupt record | "isn't running" |
| App crashed and its port reused | **The dead app's secret was sent to whatever now held the port** |

**Cause.** Discovery was one file, in a directory chosen by the shell's environment, overwritten by every launch and never tied to a process. Any failure at all became "the app isn't running", and the app ignored errors writing that file.

**Fix** (`src-tauri/src/discovery.rs`):
- Each open app has its own record, so one closing can't hide another. It's written atomically, with private permissions.
- Records go in the data directory named by the environment and the one named by the OS account. The CLI reads both, so its environment no longer decides what it finds.
- A record names its process: PID, start time, boot, PID and network namespaces, host. That's checked before anything goes to its port, so a dead app's secret stays put and its record is cleared. Records from another machine sharing a home directory are left alone.
- The app restores its records every 10s if they vanish, and removes them on a normal exit. It logs when it can't write them at startup.
- Errors are specific: no app (naming host and user), open but not answering, open but unreachable, turned away (the hub now answers a wrong secret), another network namespace, unreadable record. README has the table. In all of them the command still runs, with its own output and exit code.
- `control.json` is still written, for an older `peak` on the PATH. A new CLI also still works with an older app. Records are owner-checked, and the hub still requires the secret and listens on localhost only.

**A chart bug of mine, found here and fixed.** The regression run caught a drag jumping to Output. If a press had no reading and the first reading came at the end of the drag, it looked like a click. It came from my pointer change in the last delivery, so `5a1f57b` has it. `timeline.tsx` now records where the press happened. Three isolated repeats had passed, so it's intermittent; there's now a test that reproduces it.

**After the fix,** same harness, `scripts/e2e/desktop/cli-discovery.mjs`, all 20 scenarios on both final binaries. Each monitored case starts the CLI separately, sees the run as Running in the open window, then checks output in both places and exit 7 in both.

| Log | What ran | Result |
|---|---|---|
| `2-after-fix-release-app.log`, finished 14:45:33 UTC | Release app; CLI on PATH, relative, installed, and the debug build's | ALL OK, 20/20 |
| `3-after-fix-dev-app.log`, finished 14:46:57 UTC | Debug build with its UI on the dev server's port; the same CLIs, with the release build's as the other | ALL OK, 20/20 |
| `4-backend-gates.log`, 14:30:48 UTC | fmt, clippy, collector build, tests with `PEAK_REQUIRE_COLLECTOR=1` | All exit 0; 95 + 78 tests; 99.14% lines, gate 99 |
| `5-existing-window-regression.log`, finished 14:48:31 UTC | Local capture, markers, chart drag and click, stop, 1s/10s, Python and Node agents, SSH connect, attach, disconnect, reconnect | ALL OK, 12/12 |
| `6-frontend-gates.log`, 14:40:52 UTC | Typecheck, coverage, build | Exit 0; 255 tests; 100% |

The 20 scenarios also cover restart, crash and port reuse (secret not sent), frozen then thawed, another user with their own and with this user's environment, and no app at all. Rust didn't change after log 4, only `timeline.tsx` and its test. `scripts/verify-all.sh` now includes this harness; that script itself wasn't rerun.

**Immediate workaround on a build without this fix:** close and reopen the Peak app you want to use, then avoid opening and closing a second one (log 1: "reopened" and "restarted after the crash" pass). If the shell has a different data directory, run it as `XDG_DATA_HOME= peak run -- <command>` (log 1: the empty `XDG_DATA_HOME` step passes). If `peak` runs over SSH or in a container while the app is elsewhere, it really can't reach it, before or after this fix: run `peak` on the machine with the app.

**Limits.**
- The user's exact cause isn't confirmed. The new error names the host, user and reason, so the next report will say which case it is.
- Real windows ran only in the container under Xvfb. `task dev` itself wasn't run there: it's the same plain debug build, with its UI served on the dev port by the test script. `task peak:install`'s result was simulated by copying the binary to `~/.local/bin` in the container.
- Unit-tested only: another network namespace, a home shared with another machine, reboot, an older app's record. Not tested with a real older binary on either side.
- The account lookup can't help a sandbox that hides the home directory (Flatpak, strict snap). Neither was run.
- The Docker and Kubernetes window steps and the browser mock walkthrough weren't rerun. Nothing changed there beyond the chart fix above, which has unit and real-window coverage.

## Resolved: `task peak:build`, then `peak`: "command not found"

**Status: accepted and pushed as `5a1f57be524a0b7fcad2fb38838257a8f62e1419`.** Backend code is unchanged, so backend gates didn't need to run for this item.

**Cause.** Two separate things. Building never puts anything on `PATH`, and nothing said so. Worse, `task peak:build` made a
debug binary whose window loads from the dev server, so calling it directly gave a window with no UI.

**Working now, on a build from before this fix:**

```sh
bun run tauri build --no-bundle && ./src-tauri/target/release/peak    # the app
./src-tauri/target/release/peak run -- <command>                      # the CLI; the app must be open to monitor it
install -Dm755 src-tauri/target/release/peak ~/.local/bin/peak        # optional, gives a bare `peak` if that dir is on PATH
```

`task dev` remains the development launch.

**Fix.**
- `task peak:build` now makes the optimized app at `src-tauri/target/release/peak`, then says it isn't on `PATH` and prints the commands that work.
- New `task peak:install` runs `scripts/install-peak.sh`, which copies it to `~/.local/bin/peak` or `PEAK_INSTALL_DIR`. If that dir isn't on `PATH` it prints the direct path and the `export` line. It warns if another `peak` comes first, and never edits a profile.
- README, `docs/HANDOFF.md` and `examples/` explain building versus `PATH`. `examples/Taskfile.yml` keeps using the debug CLI and now gives a useful message when it's absent.
- `task dev` and the embedded collector are unchanged. `peak collector` passes on the built and installed copies.

**Evidence,** in `docs/evidence/build-to-launch/`:

| Log | Scenario | Result |
|---|---|---|
| `1-before-the-fix.log`, 10:40:42-10:46:30 UTC | Unchanged master | `peak` exit 127. The old debug binary never shows the UI in a real window with no dev server. The immediate commands above work, including both real-window steps |
| `2-documented-steps.log`, 10:47:32-10:56:16 UTC, `scripts/verify-install.sh` | Fresh export, `peak` not on `PATH`, no `node_modules` or `target` | ALL STEPS AS DOCUMENTED, exit 0: build in 322s with the message, direct `run` and `collector`, install to a temp dir with the warning, the printed `export` line in a new shell gives a bare `peak`, reinstall without a warning, an earlier `peak` warned about, default destination under a temp `HOME`, refusal with nothing built. Real profiles and `~/.local/bin/peak` checksummed unchanged |
| `3-installed-binary-window.log` | The copy installed by that run, real window, no dev server | "starts with an empty real backend" and "captures a real command" pass |

Also run by hand: `task cpu DURATION=1s` in `examples/` with the existing debug binary works. With `PEAK_BIN=/nonexistent/peak` it stops with the new message.

**Limits.**
- This host has no system WebKit, so the window was only opened in the disposable container under Xvfb. It was never opened directly on a desktop.
- No real shell profile or real `~/.local/bin` was used, as instructed. The default destination ran under a temporary `HOME`.
- The first optimized build takes about 5 minutes. The installed app still needs Tauri's system libraries. No `.desktop` entry is created. None of this ran on GitHub Actions.

## Resolved: 1s and 10s chart timeframes

**Status: accepted and pushed as `5a1f57be524a0b7fcad2fb38838257a8f62e1419`.** Requested as "we also need a 10 seconds and 1 second timeframe for the charts".
Frontend only: sampling stays at 500ms and nothing in the backend changed, so backend gates don't apply.

`1s` and `10s` now come first in the range control on Overview, Memory and Resources, ahead of the unchanged `30s 1m 5m 15m 1h All`.
It's one shared control, and it's the only place chart ranges are chosen. Compare, Machine and the sidebar sparklines have no range control.

**What short windows needed beyond the two options:**

| Problem | Before | Now |
|---|---|---|
| Axis ticks | 1 or 2 labels at 1s | Steps of 100, 200 and 500ms, labelled in tenths (`16:20.6`, `09:00:18.6`). 10s stays in whole seconds, every 2s |
| Tooltips | Samples 500ms apart could share a label | Tenths for windows of 10s or less. Longer windows are as they were |
| Drag to zoom | Needed 2s, impossible in a 1s window | Needs two samples at 1s and 1s at 10s. 30s and longer are unchanged |
| Dragging a moving chart | A 1s window crosses the plot every second, so the pointer lost its place | All linked charts hold their range and data from press to release, then catch up. Found in the real browser, not by unit tests |
| Zoom bounds | Could snap to a sample past the edge | Clamped to the visible window |
| Pointer with no reading | Recharts reports no time while the nearest sample is past the plot's edge, so the drag end or the press was dropped. Found only in the real window | The drag reaches the window edge on that side. A press with no reading still holds the charts, and the drag starts at the first reading. A click with no reading does nothing, and trying again works |
| Zoom label | "0s" for short zooms | Tenths and the real length, e.g. `11:16:26.8 – 11:16:27.3 · 553ms` |
| Sparse data | No line if samples were further apart than the window | One real sample past each edge, so the line crosses. Nothing is invented |
| Y axis | Could clip that line, or collapse with no sample inside | Scales to the samples the line runs towards |
| One sample | Drew nothing | Draws a point |
| Linked charts | Could differ by a frame | Same-interval charts redraw in the same frame |
| Memory trend | Would say "Stable." from 3 samples | "Too few samples" under 10, with no slope or R². This applies at any range, so very short runs see it too |
| Marker clicks | The 1.5% tolerance was far below one sample at 1s | At least half a sample |

Redraws are capped at the 30s range's existing rate (every 30ms), rather than the 60fps that short windows would otherwise ask for. A live 1s window shows 2 or 3 real samples, and the control says "one sample every 500ms".

**Validation** (fixture and mock unless marked real):
- `docs/evidence/charts-1s-10s/frontend-gates.log`: `bun run test:coverage` 254 tests in 30 files, 100% statements, branches, functions and lines, thresholds unchanged. `bun run typecheck` and `bun run build`: exit 0.
- New `src/components/charts/timeline.test.tsx`, plus additions to the series, format and hook tests. For both presets: exact span and boundaries, unmerged samples, live advancement, freezing at a stored run's end, ticks, labels, tooltips, linked ranges, zoom and hold, and sparse and one-sample data.
- Real Chromium against the **simulated** browser mock, ALL OK, exit 0 (`docs/evidence/charts-1s-10s/browser-mock.log`, `scripts/e2e/mock-e2e.mjs`): both presets live, linked axes across charts, advancement, tenths, tooltip, zoom and reset; a stored run holding still with a steady tooltip; "Too few samples"; no overflow at 1100px; every earlier step still passing.
- **Real window, real `/proc` samples** (`docs/evidence/charts-1s-10s/real-window.log`, 11:31:49-11:32:42 UTC, release binary sha256 `6087af8e`, disposable container, Xvfb): ALL OK. Both presets on a real `sleep 45`: linked axes, labels and advancement, then a real drag, e.g. `0:10.8 0:11.0 ... 0:11.6`, zooming to `11:32:23.8 – 11:32:24.8 · 950ms`. The same binary also passes the existing capture, marker, chart drag, chart click and stop steps (11:35:45-11:36:28 UTC). That window step is now part of `scripts/e2e/desktop/desktop.mjs`. Only these steps ran, not the full 24-step suite, which has no SSH, Docker or Kubernetes changes to check.

**Known limit: tooltips on a moving 1s chart.** Recharts holds the hovered point by array position, not by pointer position. On a live 1s window, with the pointer at rest, the tooltip was blank in 12 of 59 frames in a 4-second sample (headless Chromium, software rendering), when its sample was outside the plot. It was 0 blank frames at 10s, 30s and 1m, and 0 on a stored run at 1s. What it shows is always the right sample. To read values at 1s, zoom, use Freeze or open a stored run.

**Also:** screenshots are in `/mnt/HC_Volume_107248377/.peak-sysroot/evidence/charts-1s-10s-final/`, outside the repo. A live window past the last sample stays empty with its axes intact, which is what a stalled remote target shows. That case is unit-tested only. There is no pan gesture in Peak, so zoom and reset cover it. Frame rates in headless software rendering (11-21fps at every range) say nothing about a real GPU.

## Resolved bug: "no peak-collector build for x86_64 is available"

Reported on Docker target `sportboekernl-laravel.test-1`, launched with `task dev`. **Status: fixed and verified. The fix is
committed and pushed as `e7131b71298a07d5f51b3d40eb2e1b5b9aa5a047`.**

**Cause.** `task dev` runs `bun run tauri dev`, which builds only the `peak` package. Nothing built `peak-collector`, so the
lookup found nothing. The accepted validation always supplied one through `PEAK_COLLECTORS`, so it never hit this.

**Fix.** `src-tauri/build.rs` builds the static musl collector, adding the rustup target if needed, and embeds it in the
app. `src/bundled.rs` unpacks it to the data directory for transports to copy. Every way of building Peak now carries one,
including installers. An override still comes first; a glibc sibling build is now the last resort. `peak collector` shows
which one is in use. Release builds refuse to build without one, and CI's `PEAK_REQUIRE_COLLECTOR=1` extends that to debug.
`task dev` also runs `bun install --frozen-lockfile`, so a clean checkout starts. `task collector:build` is removed.

**Workaround for a build still at `dfa4dd3`:** run `task collector:build`, then press Connect again. No restart is needed.
Verified in log 1. Once this fix is pulled, `task dev` alone is enough.

**Evidence,** in `docs/evidence/collector-bug/`:

| Log | Scenario | Result |
|---|---|---|
| `1-reproduction-at-dfa4dd3.log` | Fresh export of `dfa4dd3`, no override, real disposable Docker | No collector artifact after a build; **`Failed`, with the reported message**. Then `task collector:build`: `Connected` |
| `2-clean-start-task-dev.log` | **Primary case, final code:** `task dev` from an export with no `node_modules`, no `target`, no `PEAK_COLLECTORS`, no collector file, musl target removed | Launched in 125s; target added by itself; `peak collector` exit 0 |
| `5-real-window-exact-task-dev-binary.log` | **Final code:** that exact binary (sha256 `db26a7bc36b02b7e`) in a real window, real isolated Docker daemon, no collector supplied | Docker step passes: totals, logs, collector, attach, detach |
| `3-live-docker-from-clean-start.log` | Clean-start copy, host daemon: `alpine:3.20`, and a disposable container from the reporter's image `sail-8.5/app` | `Connected`, real samples, on both. The reporter's container was not touched: same id and uptime before and after |
| `4-real-window-task-dev-binary.log` | Full 24-step window suite, no collector supplied: local, SSH, Docker, Kubernetes | ALL OK. Binary relinked by `cargo test` from the same source, so not byte-identical to log 5's |
| `6-deb-package.log` | `bun run tauri build --bundles deb`, unpacked (not installed); `peak collector`; real window against real Docker | Exit 0; one binary, no extra files; Docker step passes |
| `7-no-collector-available.log` | Target absent, cache removed, `rustup target add` failing | Debug warns with the cause, and `peak collector` gives the actionable message, exit 1. Release refuses, exit 101. CI's guard refuses, exit 101. `PEAK_ALLOW_NO_COLLECTOR=1` builds |
| `8-affected-gates.log` | Affected required gates, `PEAK_REQUIRE_COLLECTOR=1`, no override | Below |

Logs 3, 4, 6 and 7 ran before the last `build.rs` edit, which only added `RUSTC_WRAPPER` to the list of cleared settings, plus
wording and formatting. Logs 2, 5 and 8 ran on the final code. Only docs changed after them.

**Gates (log 8, 10:24-10:26 UTC):**

| Command | Result |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo build -p peak-collector` without the desktop's libraries | exit 0 |
| `cargo llvm-cov --workspace --ignore-filename-regex '(lib\|main\|live_\w+)\.rs$' --fail-under-lines 99` | exit 0; 155 tests; **99.10% lines**. `bundled.rs` 100% |
| `cargo test --test live_ssh -- --ignored --test-threads=1` | 3/3, using the embedded collector |
| `cargo test --test live_docker -- --ignored --test-threads=1` | 4/4, including new `an_ordinary_build_connects_with_nothing_prepared` |

Not rerun, because nothing they cover changed: the frontend suite (no `src/`, `package.json` or `bun.lock` change) and the agent
suites. `live_kube` wasn't rerun, but Kubernetes passed through the real window in log 4.

The verification found one more bug before it could reach CI: `cargo-llvm-cov`'s `RUSTC_WRAPPER` broke the nested build. Without the
new CI guard, coverage builds would have silently dropped the collector.

**Limits.**
- This machine has no system WebKit, so the plain `task dev` window can't open on it. The build and launch ran here with private
  webkit dev libraries, and the same binary's window ran in a container against a static copy of the frontend, not the Vite server.
- x86-64 only. An x86-64 app reports that it has no collector for other architectures. Building on arm64 should embed an arm64 one, but
  that hasn't been run.
- The `.deb` was unpacked, not installed. `.rpm` and AppImage weren't built. Nothing here has run on GitHub Actions.
- The first `task dev` after a clean checkout adds about 20s for the collector, and needs network access if the rustup target is missing.
- `task dev` on a machine without rustup gets a working local app, a build warning, and the "doesn't include one" message on remote targets.
- Targets keep an existing copy of the collector while its version and protocol are unchanged.
- The reporter's own container hasn't been connected to, to leave it unchanged. Its image has been.

`*.log` is ignored by git, so new evidence logs wouldn't have been picked up by a normal `git add`. `.gitignore` now keeps
`docs/evidence/**/*.log`, so this bug's logs appear in `git status`.

**Next action:** the reporter pulls latest master, restarts `task dev`, and presses Connect on the existing target.

## Final verification (of delivery `dfa4dd3`)

Run with `PEAK_TOOLS=/mnt/HC_Volume_107248377/.peak-sysroot scripts/verify-all.sh`, 05:29:50-05:38:00 UTC, on the
same code as this checkout apart from docs. Result: **ALL CHECKS PASSED**.

- Log: `docs/evidence/20261106T0529Z/verification.log`
- Notifications received by the daemon: `docs/evidence/20261106T0529Z/notifications-received.log`
- Screenshots: `/mnt/HC_Volume_107248377/.peak-sysroot/evidence/20261106T0529Z/{browser,desktop}/` (outside the repo: 6 MB)

### Required gates

Backend gates cover the whole workspace: `peak-core`, `peak-collector` and the desktop `peak` package.

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run test:coverage` | 29 files, 213 tests pass; exit 0 with 100% thresholds enforced in the unchanged `vitest.config.ts`. The log clipped the per-file table; the script now keeps it |
| `bun run build` | exit 0 |
| `bun run test:agents` | Node 24: 4/4. Python 3.13.16: 8/8. Python 3.12: see the supplement below |
| `node --test src-tauri/agents/tests/*.test.mjs` on Node 20.20.2, 22.23.4 | exit 0 each |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo build -p peak-collector`, without the desktop's libraries in the environment | exit 0 |
| `cargo build -p peak-collector --release --target x86_64-unknown-linux-musl` | exit 0 |
| `cargo llvm-cov --workspace --ignore-filename-regex '(lib\|main\|live_\w+)\.rs$' --fail-under-lines 99` | exit 0; 150 tests; 99.19% lines (7001 lines, 57 uncovered). Gate unchanged at 99% |

The coverage filter now also excludes `live_*.rs`, which are test harnesses for real infrastructure; product code
is still fully counted. `peak-collector` is only a `main.rs`, already excluded as thin glue, and is exercised by
the live suites. Its logic is `peak-core/src/collector.rs`, at 97.55%.

### Supplemental CI-contract evidence (05:44-05:46 UTC)

The 05:29 run didn't cover these two parts of CI: a frozen install, and Python 3.12 (it used 3.13.16). They were run
separately, in `docs/evidence/supplement-20261106T0544Z/`:

| Log | What ran | Result |
|---|---|---|
| `1-first-attempt.log` | `bun install --frozen-lockfile`, Bun 1.4.3, fresh temp directory | exit 0, 460 packages, hashes unchanged. Its control was too weak: `^2.0.0` still matches the lock, so it didn't fail |
| `1-first-attempt.log` | Agent tests on stock Ubuntu Python 3.12.3 | **exit 1, 4 errors of 8**, on three consecutive runs. See below |
| `2-python312-clean-unchanged-tests.log` | **Unchanged** tests, `python -m unittest discover -s src-tauri/agents/tests -v`, clean CPython 3.12.16 (`python:3.12-slim`), no preloaded `sitecustomize`, same as CI's runtime in that respect | **8/8, exit 0** |
| `3-after-test-import-fix.log` | Same command after the fix: Ubuntu 3.12.3 and clean 3.12.16 | **8/8, exit 0 on each** |
| `3-after-test-import-fix.log` | `bun run test:agents` (Node 24, Python 3.13) | Node 4/4, Python 8/8, exit 0 |
| `3-after-test-import-fix.log` | `bun install --frozen-lockfile`, repeated | exit 0, hashes unchanged. Control with a dependency missing from the lock: refused, exit 1 |

**Cause of the 4 errors:** a flaw in the test, not the agent. Ubuntu's Python preloads its own `sitecustomize` (an apport
hook), so the test's `import sitecustomize` returned that module. The four tests running the agent in real processes
passed throughout. The test now loads the agent by file path; assertions are unchanged.

**The 05:29-05:38 run still applies.** Against a snapshot of all 185 non-doc files, only
`src-tauri/agents/tests/test_python_agent.py` changed, and only its import. It's in neither coverage scope, and nothing
builds from it. Checks rerun were limited to the agent suites above. `package.json` (`6eb80a91...`), `bun.lock` (`7325762c...`) and
`src-tauri/agents/python/sitecustomize.py` (`d15b86a7...`) are unchanged, as is all product code. After the run,
`scripts/verify-all.sh` also changed, in its log length only.

**Limits:** none of this ran on GitHub Actions, because nothing has been pushed. CI's `setup-bun` takes the latest Bun,
not necessarily 1.4.3; `python:3.12-slim` stands in for `actions/setup-python`.

### Live, browser and desktop

| Check | Kind | Result |
|---|---|---|
| `cargo test --test live_ssh -- --ignored` | **Live**: real OpenSSH, disposable sshd on loopback | 3/3 |
| `cargo test --test live_docker -- --ignored` | **Live**: real daemon, disposable containers, `ssh://` context | 3/3 |
| `cargo test --test live_kube -- --ignored` | **Live**: real API, disposable k3s | 1/1 |
| `scripts/e2e/desktop/run.sh` | **Live**: real binary and real window, with real SSH, isolated Docker daemon, k3s and `dunst` | 24/24 steps |
| `scripts/e2e/mock-e2e.mjs` | Real Chromium, **simulated data only** | 11/11 steps |

Unit and pipe-based tests are **fixtures**, not evidence of a real connection. See `docs/REMOTE-VALIDATION.md`.

## Acceptance milestones

"Desktop" means the real window with the real backend. "Browser" means real Chromium with the mock.

| # | Milestone | Desktop | Browser | Automated tests | Remaining limit |
|---|---|---|---|---|---|
| 1 | Runtime agents | Lag and CPU profile from real Python and Node | - | Agent suites, `profiles_real_*` | Bun has no agent. V8 can charge OSR code to its caller |
| 2 | History | Browse, reopen marked "From history", survives restart | Search, reopen | `history-page`, service tests | Single-run delete is unit and backend tested, not driven in a window |
| 3 | Settings | Save, survive restart, delete all stopped, compact, running workload undisturbed | Theme, delete all, survive reload | `settings-page`, mock tests | Age prune is unit and backend tested, not driven in a window |
| 4 | Comparison | Two real stored runs, session unchanged | Unequal lengths | `compare`, `compare-page` | |
| 5 | Report | Verdict, allocators, copy accepted by the webview | Markdown and JSON content read back | `report`, `report-tab` | Clipboard contents read back in Chromium only |
| 6 | Timeline | stderr and alert markers, real drag zooms, real click opens output | Same, plus snapshot and GC markers | `markers`, `logs-panel` | |
| 7 | Alerts | Memory and sustained CPU, toast, marker, delivered to `dunst` once per crossing, none when off | Memory alert toast | `alerts`, `notify` | Real desktop shells not run |
| 8 | Resources | Real port 18765, children, lag, handles | Sections render | `resources`, `resources-tab` | |
| 9 | Machine | Real host data, strip and page | Strip and page | `machine`, `machine-page` | |
| 10 | CPU profile UI | 5s recording, sampling method stated, stored profile reopened | Progress, time values on hover | `profiler-cpu` | 10s path is unit-tested |
| 11 | Remote | SSH, Docker, Kubernetes through the UI | Simulated targets | `remote`, `transport`, `collector` | See below |

Local capture, attach, stop, restart, logs, heap snapshots and GC keep working (desktop run and existing suites).
`peak run` is covered by its existing `cli` tests, not the desktop run.

## Not validated

Full list: `docs/REMOTE-VALIDATION.md`. The main ones: SSH to another machine over a real network; differing or
changing clocks; a real reboot; arm64; a Docker engine on another machine; images with no shell; managed Kubernetes;
measured metrics for application pods (system pods only); notification display on real desktops; packaged installers,
which don't yet bundle the collector. The desktop window ran as a debug build under Xvfb with software rendering.

## What verification found

Bugs that only real runs exposed, all fixed: gaps never reached the UI; a stale queued delta could overwrite a detach's
status; ticks arriving before a run was registered were dropped; `can-i pods/log` asked about a pod named `log`;
a metrics NotFound read as a missing pod; pruning closed the Settings page; a replaced pod retried forever.

## Corrections to earlier notes

- The first handover presented agent evidence without noting it ran on Python 3.13, not CI's 3.12, and had no frozen-install
  result. Both are now covered by the supplement above.
- An earlier version of this file said the browser walkthrough passed twice "at 03:45 UTC". That time was an estimate,
  written before it happened. Screenshot timestamps show the second of those runs ending at 03:33:28 UTC.
- The 04:32 run (`docs/evidence/2026-11-06-0432-verification.log`) failed `live_kube` at its metrics step. The 05:15 run
  (`docs/evidence/20261106T0515Z/`) failed it at pod scheduling, because the eviction setting hadn't applied. Both are
  kept as records and were fixed before the final run.

## Environment

- webkit2gtk dev libraries are absent here. They're extracted rootlessly to `/mnt/HC_Volume_107248377/.peak-sysroot`,
  along with `kubectl`, `tauri-driver`, Playwright and Node 20/22. Nothing was installed system-wide. The rustup musl target
  is installed in the user's toolchain.
- The root disk holds Docker's data: 95% full (4.1 GB free) after cleanup. The disposable images I pulled are removed, including those re-created for today's window checks,
  and no `peak-live` containers or networks remain. Docker's build cache was left alone because it's shared; it's
  2.2 GB in total and includes layers from this work, so `docker builder prune` is the owner's call.

## Quota

One interruption. From the PM's record (`docs/PROJECT-MANAGEMENT.md`): limit hit at 2026-11-06 00:37:54 UTC, "You've hit
your 5-hour limit · resets 3:20am (UTC)". Work resumed at 03:23 UTC. Work in progress was preserved uncommitted in the
checkout; nothing was lost. No further limit since.

## Next action

The CLI discovery fix is accepted and pushed. Close old Peak instances when ready to restart, pull latest master, run `task peak:install`, reopen the updated app and retry the CLI on the same machine/user. If it still fails, report the new error line plus the CLI and app-launch commands. Reporter-specific confirmation remains pending; no continuous goal or scheduled checkpoint is active.

The broader open platform/live gaps remain in `docs/REMOTE-VALIDATION.md`.
