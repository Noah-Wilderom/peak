# Peak development status

Durable handover for PM checkpoints. Acceptance criteria: `docs/ACCEPTANCE.md`.
Remote evidence and open gaps: `docs/REMOTE-VALIDATION.md`.

- **Last update:** 2026-11-06 05:46 UTC
- **State:** all eleven milestones implemented; final verification passed on this code. Awaiting PM acceptance.
- **Commits:** none. All work is uncommitted in the shared checkout (94 changed paths; no commit was requested).

## Final verification

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
  along with `kubectl`, `tauri-driver`, Playwright and Node 20/22. Nothing was installed system-wide.
- The root disk holds Docker's data: 95% full (4.1 GB free) after cleanup. The disposable images I pulled are removed
  and no `peak-live` containers or networks remain. Docker's build cache was left alone because it's shared; it's
  2.2 GB in total and includes layers from this work, so `docker builder prune` is the owner's call.

## Quota

One interruption. From the PM's record (`docs/PROJECT-MANAGEMENT.md`): limit hit at 2026-11-06 00:37:54 UTC, "You've hit
your 5-hour limit · resets 3:20am (UTC)". Work resumed at 03:23 UTC. Work in progress was preserved uncommitted in the
checkout; nothing was lost. No further limit since.

## Next action

PM acceptance. After that, the open items are the live gaps above, packaging the collector, and an arm64 build.
