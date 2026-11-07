# Peak development status

Durable handover for PM checkpoints. Acceptance criteria: `docs/ACCEPTANCE.md`.
Remote evidence and open gaps: `docs/REMOTE-VALIDATION.md`.

- **Last update:** 2026-11-07 02:17 UTC
- **State:** **`v0.1.0` is published and its public delivery checks pass on all four targets,** at `9e60f67`. Next scope, not started: Go, Bun and PHP profiling agents.
- **PM delivery update:** 2026-11-06 14:56:54 UTC. CLI fix: `a1defaa786fc1d1a1e3da836540368a1ddc78eda` on `origin/master`; remote SHA verified and checkpoints disabled.
- **Commits:** the original delivery is committed and pushed: `origin/master` at `dfa4dd3befcdfc67a5131ce55ce3b67ce78a5876`. The collector fix is committed and pushed as `e7131b71298a07d5f51b3d40eb2e1b5b9aa5a047`.

## Current scope: packaged releases and automatic updates on Linux, Windows and macOS

**Settled by the user:** the first release supports all three platforms, and it's published once verified, not left as a draft for review. PM publishes after acceptance.

**Status: published at 2026-11-07T01:34:22Z, by PM. Required public checks pass.**

### Public results: `v0.1.0`, commit `9e60f67`

**Public delivery** rerun 42326884105, against the published release, on the corrected workflow at `8d95ca7`: **success, nine jobs of nine.** Tests 42326876604 on that commit: success, backend 99.15% lines (gate 99), frontend 100%. Summaries in `docs/evidence/release/ci-public-rerun-v0.1.0/`. The release was unchanged between runs: 18 assets, same tag, and `verify-published.mjs` still ALL OK from here afterwards.

| Check, against the real public release | Linux x86_64 | Windows x64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Anonymous feed, downloads, checksums, signatures | **Pass**, one job covering all targets | | | |
| Install from public URLs, app, separate CLI, samples, exit code, Node and Python agents | **Pass** | **Pass** | **Pass** | **Pass** |
| 0.0.9 finds the release on the real feed, downloads, verifies the production signature, installs, relaunches | **Pass** | **Pass** | **Pass** | **Pass** |
| Through that: history kept, `peak run` workload survives with its own exit code, new app monitors the CLI | **Pass** | **Pass** | **Pass** | **Pass** |

The first run, 42324783966, kept in `docs/evidence/release/ci-public-v0.1.0/`, failed one job: the Linux install, explained next. Its other eight jobs passed.

**That first Linux failure, and what it means.** `peak: error while loading shared libraries: libEGL.so.1`. That job's runner had only `libfuse2` and `xvfb`. Every earlier Linux check had WebKit dev packages installed, which pulled these libraries in and hid the dependency. The published AppImage expects 13 libraries from the host: `libEGL`, `libGL`, `libX11`, `libX11-xcb`, `libdrm`, `libexpat`, `libfontconfig`, `libfreetype`, `libfribidi`, `libgbm`, `libharfbuzz`, `libwayland-client`, `libxcb`. **The release isn't corrupt, and no containment is needed.** It does mean:
- **On a bare server or minimal container, Peak doesn't run at all, including `peak run` and `peak version`.** The README said nothing about this, and now does. Not tested on a full desktop install, or on other distributions; the list above suggests they'd be fine, since desktops carry these libraries.

**Run by me, against the real public URLs:**

| Log | What ran | Result |
|---|---|---|
| `16-verify-published-real.log` | `verify-published.mjs`, anonymous | ALL OK, 24 checks |
| `17-real-install-linux.log` | The README's `curl \| sh`, Ubuntu 22.04 chroot. Installed file matches `SHA256SUMS`; smoke test on it | SMOKE OK |
| `18-clean-linux-public.log` | The public AppImage on **clean Ubuntu 22.04 and 24.04 containers**, with only those 13 libraries' packages and no dev packages: full smoke test and `curl \| sh`. Then the public `.deb` on clean 24.04, with apt pulling its own dependencies | SMOKE OK on both. The `.deb` installs and its CLI works; **its window wasn't opened** |
| `19-real-feed-button-linux.log` | The production app from the public URL, its real "Check for updates" button, the real feed | "This is the latest version" |

Those containers run with AppArmor and seccomp unconfined, so they say nothing about Ubuntu 24.04's restrictions on unprivileged sandboxes in a real desktop session. That hasn't been tested.

**What the public proof covers, and doesn't.**
- **Covers:** GitHub's redirects, TLS, the real feed, real downloads and the production signature, end to end on all four targets, ending with the exact published release running.
- **Not a person using the production UI:** the 0.0.9 copy presses the buttons on a timer. Buttons were exercised on Linux and Windows against a localhost feed; on Linux, also the production check button against the real feed. **macOS UI evidence is timed presses and screenshots.** Windows' window flow uses a debugging port set only in test builds.
- **Not two production releases:** the 0.0.9 copy isn't a release build. A real user's first update between production releases happens at the next release.
- **Not clicked through by a real OS-warning path:** CI runners don't quarantine downloads, so macOS Gatekeeper and Windows SmartScreen warnings have never been seen by these tests. The README's steps come from Tauri's signing documentation and known OS behaviour, not from observing them here.
- **Remote targets from Windows and macOS** have never run.
- Nothing is notarized or OS-signed, by decision.

**Fixed in the uncommitted tree, reaching users only at the next release, since `install.sh` is a release asset and no tag changes:** `install.sh` now says which libraries are missing and how to install them, rather than reporting success, and its libfuse2 note no longer fires falsely when `ldconfig` isn't on `PATH`. Tested on a bare 24.04 container.

**Not changed:** the app, the tag and the release.

### The tag: `v0.1.0` on `9e60f67`

Release 42322047772 on the tag: all four native rebuilds, signatures, install, app, separate CLI, real samples and Node and Python agents pass, and the draft step succeeded on its first real run. Tests and Update proof on that commit also pass. It differs from the candidate below only in docs and evidence. Summaries: `docs/evidence/release/ci-tag-v0.1.0/`. Draft checks: `docs/evidence/release/14-draft-v0.1.0.txt`.

### The candidate: `f17d80dc1da1d56295f6cab990a65724c5379ab4`

Update proof 42319370930, Release 42319358434, Tests 42319358452, all on that exact commit, all success. Summaries in `docs/evidence/release/ci-f17d80d/`. Artifact identities, build commits, signature checks, `SHA256SUMS` and feed shape in `docs/evidence/release/13-candidate-f17d80d.txt`.

| Check | Linux x86_64 | Windows x64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Production package, updater signature checked independently | **Pass** | **Pass** | **Pass** | **Pass** |
| Install, app, separate CLI, real samples, exit code, right directory, clean environment | **Pass** | **Pass** | **Pass** | **Pass** |
| Node and Python agents, by loop lag, which only an agent sends | **Pass** | **Pass** | **Pass** | **Pass** |
| Real signed upgrade and relaunch; history kept; CLI workload survives | **Pass** | **Pass** | **Pass** | **Pass** |
| Offline, no update, HTTP 500, malformed feed, missing, truncated, tampered, wrong key | **Pass** | **Pass** | **Pass** | **Pass** |
| Real window: found by itself, nothing downloads until asked, progress, signature-failure message, restart names what it stops and can be declined, settings and history kept | **Pass** | **Pass** | Not possible | Not possible |
| Native core tests | Covered by **Tests** | **Pass** | **Pass** | **Pass** |

**Tests** passes: backend gate at **99.16% lines** on CI (7957 lines, 67 uncovered, gate unchanged at 99), frontend at 100%, both agent versions. It includes the early-agent regression test and the artifact-selection controls.

Local on this tree: the manifest and verifier passed 24 of 24 checks on this run's artifacts (log 11), served locally, not by GitHub.

**What this doesn't show.**
- **The `hdiutil` failure:** that run didn't need the retry, so the retry itself is untested, and the fault may recur.
- **The Linux window failure on `64a4d5d`:** still an inference that the click found nothing. The harness change came with a pass, which fits, but it doesn't show the cause.
- **macOS:** its upgrade is driven by a proof build pressing buttons on a timer, because it has no WebDriver. No check has clicked through the macOS update UI.
- **The Windows window flow** uses a debugging port set only in that job's test builds.
- **Remote targets from Windows and macOS** have never run.

**Earlier causes, as established.**
- **Established:** the Windows upgrade failure was the stale-installer selection in `collect.mjs`. The early-agent race is real, with a test that fails without the fix.
- **Unknown, probably the same:** the `187f415` timeout, whose error wasn't captured.
- **Not established:** that a running `peak-cli.exe` would block the installer. The hook moves it, as the logs show, but no run has gone without the hook.

### The real GitHub feed: how it gets proven

**No second release and no test releases are needed.** `.github/workflows/public-delivery.yml` runs by itself when a release is published, needs no secrets and publishes nothing. On all four targets:
- **Install:** downloads the artifact from the public URL anonymously, checks it against `SHA256SUMS`, then runs the full smoke test: app, separate CLI, samples, agents.
- **Update:** `scripts/e2e/smoke/public-update-proof.mjs` builds an older copy at 0.0.9 with the real update URL and the real public key. It records a run, starts a `peak run` workload, and then finds the release through the real feed, downloads it from GitHub, verifies the production signature, installs and relaunches. Afterwards that machine is running the exact published release, with history and the workload intact.
- **Verify:** `verify-published.mjs` checks the feed, every download, checksums and signatures anonymously.

The older copy differs from a release in its version and in pressing the update buttons by itself after 25 seconds, so this isn't a person clicking through the production UI. That's covered on Linux and Windows by the window flow, against a localhost feed. On macOS nothing covers it beyond the timer and screenshots.

Rehearsed on Linux against the real production-signed AppImage from CI, with a local server standing in for GitHub: **PUBLIC UPDATE OK** (log 12). The GitHub part can't run until a release exists, and it can fail. **If it fails after publishing, users already have that release,** so the fix goes out as a new version. Because the feed is what's under test, an installed copy that can't update would need reinstalling by hand.

### The run before: `110e1c4`

Update proof 42311128624, Release 42311128833, Tests 42311128677. Summaries in `docs/evidence/release/ci-110e1c4/`, Windows screens in `screens/`.

| Check | Linux x86_64 | Windows x64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Production package, updater signature checked independently | **Pass** | **Pass** | **Pass** | **Pass** |
| Install, app, separate CLI, real samples, exit code | **Pass** | **Pass** | **Pass** | **Pass** |
| Node and Python agents, as checked on this commit (see below) | **Pass, weak for Node** | **Pass** | **Pass** | **Pass** |
| Real signed upgrade and relaunch; history kept; CLI workload survives | **Pass** | **Pass** | **Pass** | **Pass** |
| Offline, no update, HTTP 500, malformed feed, missing, truncated, tampered, wrong key | **Pass** | **Pass** | **Pass** | **Pass** |
| Real window: found by itself, nothing downloads until asked, progress, failure message, restart names what it stops and can be declined, settings and history kept | **Pass** | **Pass** | Not possible | Not possible |
| Native core tests | Covered by **Tests** | **Pass** | **Pass** | **Pass** |

**Tests** passes: backend gate at **99.17% lines** on CI (7933 lines, 66 uncovered, gate unchanged at 99), frontend at 100%, both agent versions.

macOS has no WebDriver, so its upgrade is driven by a proof build that presses the buttons on a timer, and its UI evidence is screenshots. The Windows window is driven through WebView2's debugging port, set only in that job's test builds.

**Found after that run, fixed, needs the final CI run: agents could silently miss a whole run.** With `peak run`, a run only becomes known once the CLI's "started" message is handled. A fast-starting runtime's agent could say hello first, be dropped, and never retry, so that run had no heap, GC or lag data and nothing said so. This was intermittent and timing-dependent. It failed every time in the slower chroot on the `110e1c4` artifact, and passed on CI runners. The check that found it came from a suspicious number: on Linux the old check accepted a heap figure that's an estimate when no agent reports. It now requires loop lag, which only an agent sends. **So `110e1c4`'s Linux Node result was weak**, and its other agent passes show the race doesn't always strike, not that it can't. `hub.rs` now gives an agent 3 seconds for its run to appear. A test fails without the wait and passes with it, and the smoke test passed three runs out of three where it had failed every time (`docs/evidence/release/10-install-script.log`).

**What each Windows story turned out to be.**
- **Established:** the upgrade failed because `collect.mjs` shipped a 9.0.0 installer under the 9.0.1 name, and the updater refused it. With the fix it passes. Controls: `scripts/release/collect-check.mjs`, in **Tests**, results in `9-artifact-selection.log`.
- **Unknown:** the first timeout on `187f415`. Its error wasn't captured. Same symptom, so probably the same cause.
- **Not established:** that a running `peak-cli.exe` would block the installer. `110e1c4`'s log shows the hook did move it (`peak-cli.old.1093140`), and the upgrade passed with the workload running, but no run has gone without the hook.
- **Established:** the Windows debugging port works when set in the build's config. It didn't when asked through the environment. Why isn't established; my reading, that Tauri's own browser arguments replace the variable, is untested.

**Also run, locally, on real artifacts from `110e1c4`:**
- `install.sh`'s download route for the first time: fresh install with a menu entry, replacing a source-built copy, and a corrupted download refused with the install unchanged (log 10). Local server, so not GitHub.
- `manifest.mjs` on all four targets' artifacts, then the new `scripts/release/verify-published.mjs`: 24 checks, all ok, including downloads, checksums and signatures (log 11). Also local.

**Local gates on the final tree:** backend 99.16% lines, frontend 100% with 295 tests, fmt and clippy clean. Logs 4 and 6.

**User decisions, settled.** Publish from `Noah-Wilderom/peak`, now public (PM changed it at 23:02 UTC and verified it anonymously). Ship with documented OS warnings: nothing is notarized or code-signed by an OS vendor, and the README says what users see and how to get past it. Updater signatures stay mandatory. No certificates or Apple account are needed.

**Limits that will still be true at release.**
- **Delivery isn't proven until it happens.** The feed is a 404 until a release is published, and `verify-published.mjs` must run against the real URLs right after.
- **One upgrade path through GitHub has a stand-in:** the 0.0.9 copy above. A real user's first update through GitHub, between two production releases, happens at the next release.
- **Remote targets from Windows and macOS** are built in but have never run: they need a real machine with a Linux target.
- **Capabilities differ by platform.** The README's table is the reference. Handles, ports, memory composition and PSI are Linux-only, and shown as such.
- **Stopping a windowless program on Windows** gives it no chance to clean up.
- **Evidence on commits:** logs for a commit can only land in a later one, and the tag's own workflow rebuilds and smoke tests everything again.

**Open for PM: an off-server backup of the updater key.** Losing it strands every installed copy.

### How it got here

**Third native CI, on `676efdc`** (Update proof 42303290111, Release 42303290122, Tests 42303290139; summaries in `docs/evidence/release/ci-676efdc/`):

| Job | Linux | Windows | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Production package, independent signature, install, app, separate CLI, real samples | **Pass** | **Pass, signature truly checked** | **Pass** | **Pass** |
| Real signed upgrade | **Pass** | **Fail, cause below** | **Pass** | **Pass** |
| Failure cases in that proof | **Pass** | **Pass** | **Pass** | **Pass** |
| Upgrade through real buttons | **Pass** | **Fail, driver below** | Not possible | Not possible |
| Native core tests | Covered by **Tests** | **Pass** | **Pass** | **Pass** |

**Tests** passes: backend gate at the unchanged 99%, frontend gate at 100%, and both agent versions. Note on the backend figure: the gate passed over the whole workspace, but the report step printed 98.98% because it only covered the root package, leaving out `peak-core`. CI's own coverage file works out at 99.47% across both, by a different line count than the gate's. The step now prints the gate's own figure.

**Windows upgrade: cause established from the app's own error, and confirmed by the pass on `ea3ebc1`.** "The update was signed for version 9.0.0 but the update endpoint announced version 9.0.1." `scripts/release/collect.mjs` took the first installer in the bundle folder, which keeps earlier versions. On Windows that listed 9.0.0 first, so 9.0.0 was copied under the 9.0.1 name. **Peak's updater was right to refuse it**; the fault was the test build's packaging. It was also a release risk, had a bundle folder ever kept an old version. The script now only takes the file for this version, and fails unless the signature says that version. Tested locally on a fake folder holding both versions, with a stale-only folder and a mismatched signature: both refuse. The earlier `187f415` timeout probably had this cause, though that run's error wasn't captured.

**Windows buttons:** `msedgedriver` couldn't attach ("DevToolsActivePort file doesn't exist"). `update-ui.mjs` moved to WebView2's debugging protocol, enabled by an environment variable. That didn't work either; see above.

Only the release scripts, the test harness, the workflows and docs changed after `676efdc`, so the app under test is unchanged, and the local gate logs stand.

**Second native CI, on `03f6ccf`** (Update proof 42298320417, Release 42298320510, Tests 42298320480; summaries in `docs/evidence/release/ci-03f6ccf/`, screenshots in `screens/`):

| Job | Linux | Windows | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Production package, signature, install, app, separate CLI, real samples | **Pass** | **Pass** | **Pass** | **Pass** |
| Real signed upgrade | **Pass** | **Fail** | **Pass** | **Pass** |
| Failure cases in that proof | **Pass** | **Pass** | **Pass** | **Pass** |
| Upgrade through real buttons | **Pass** | Never started: no driver | Not possible | Not possible |
| Native core tests | Covered by **Tests** | **One failure** | **Pass** | **One failure** |

I looked at the smoke screenshots: Windows and both Macs show the real UI with a real memory curve, thread count and exit status from a run started by a separate CLI process.

**Windows upgrade, as known at that point.** My installer-lock theory is **not supported**. In the timed-out run the app had made 98 feed requests and 97 downloads, was still running at 9.0.0, and no `peak-cli.old.*` file existed. So the installer never ran, and the failure comes after the download starts and before the installer launches. The renaming hook stays, because it's still right for a running `peak-cli`, but it's unproven. The signature is good: the same-format production artifact verifies here. The app's error wasn't visible, so proof builds now record it in their own history, and the harness prints it on timeout. The next run should name the cause.

**Other failures and fixes, uncommitted, Linux-tested only:**
- **Backend gate failed on CI** though it passed locally at 99.02%; the CI figure was hidden because the report step was skipped. Added tests, including that settings saved by an older version keep their values, so it's now **99.21%** locally, and the report always prints.
- **Windows stop:** a program with no window can't be asked to close, and `taskkill` refuses. It now ends it outright. **On Windows, stopping such a program gives it no chance to clean up.**
- **macOS x64 test** assumed zombies are detectable, which only Linux can do reliably. Windows and macOS now check after the process is reaped. Consequence: there a zombie still counts as running until reaped.
- **The independent signature check silently did nothing on Windows.** Its main-script test can't match Windows paths, so that step passed without checking. Fixed, and the workflow now fails if nothing printed "signature ok". **So `03f6ccf`'s Windows "signature" step isn't evidence**; I checked that artifact by hand.
- **`peak collector`** tried to run the Linux collector on Windows and macOS, and printed an OS error. It now says it's for Linux targets. Collectors for both architectures are embedded there, and the tests confirm they're Linux binaries; they've never run from those hosts.
- **Windows button job:** the runner has no Edge driver. The job now downloads one matching its WebView2.
- **Icons:** the app was shipping Tauri's default icon. It now has Peak's logo everywhere, from `src-tauri/icons/source.svg`.

Local gates on this tree: backend 99.21% lines, frontend 100% with 295 tests.

**First native CI, on `187f415`** (Update proof 42291210049, Release 42291210277; summaries in `docs/evidence/release/ci-187f415/`):

| Job | Linux | Windows | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Real signed upgrade and failure cases | **Pass** | Failure cases pass; **the upgrade timed out** | **Pass** | **Pass** |
| Package, signatures, install and CLI smoke | **Pass** | Stopped at the version check | Stopped at bundling | Stopped at bundling |
| Native core tests | Not in that workflow | **One test failed**, and it stopped the rest | **Pass** | Not in that workflow |

Causes and fixes, **uncommitted, not yet run on CI**:
- **Windows version check, and possibly more:** CRLF checkout. Added `.gitattributes` forcing LF, and the script tolerates CRLF.
- **macOS bundling:** empty `APPLE_*` values made the bundler try to import a certificate. They're now only set when configured.
- **Windows test:** used a `/proc` path. Now portable. `--no-fail-fast` so one failure can't hide the others.
- **Windows upgrade timeout: cause not established.** Leading theory: the workload's running `peak-cli.exe` blocks the installer overwriting it. The installer now renames it aside first, as Windows allows, and the harness dumps processes, files and a screenshot on timeout. If it still fails, that output decides.
- **Windows design fault, found reading the plugin's behaviour:** its installer ends the app the moment it starts, so "Download and install" would have been a silent restart that also skipped the usual exit steps. Windows now downloads and verifies first, says so, and installs only when the user restarts, after stopping the commands it named.
- **`peak-cli.exe` called itself a source build,** because only the main program gets stamped. It now recognises the uninstaller beside it.
- **Added to CI:** real-button upgrade jobs for Linux and Windows, core tests on macOS x64, and **Tests** on `release-validation/**`, which hadn't run on the candidate. The Windows button job relies on the runner's Edge driver matching its WebView2, so that's untested too.

Local gates on this tree: backend 99.01% lines (gate 99), frontend 100% with 294 tests. `4-backend-gates.log` and `6-frontend-gates.log` are current; the other local logs were recorded on `187f415`'s code.

**Done on Linux, verified locally.** Environment: Ubuntu 22.04 chroot (CI's base, on the data volume because the root disk is 98% full), real FUSE, Xvfb, real window. Logs in `docs/evidence/release/`.

| Log | What ran | Result |
|---|---|---|
| `1-linux-update-proof.log` | Two real AppImages (9.0.0 to 9.0.1), throwaway key, localhost feed. Offline, no update, HTTP 500, malformed feed, missing artifact, truncated download, tampered bytes and a wrong-key signature each leave the install's hash unchanged and the app running. Then the real update: downloaded, verified, replaced, relaunched. History survived, and a `peak run` workload kept running through it and exited with its own code | PROOF OK, 17 checks |
| `2-linux-update-ui.log` | Same, through the real window and buttons. Offline message in Settings with no popup; "latest version"; a tampered download refused with the reason; a release found by itself and **nothing downloaded until asked**; progress; "installed", with the old app still running and the file already replaced; a restart naming `sleep 300` and declinable; then the new version with settings and history | ALL OK, 10 steps |
| `3-cli-discovery-installed-appimage.log` | The full CLI discovery suite on the installed candidate | 20/20 after one harness fix, recorded in the log |
| `8-window-regression-appimage.log` | Capture, markers, chart drag and click, 1s/10s, Python and Node agents on the installed candidate | ALL OK, 8 steps |
| `7-browser-mock.log` | Browser walkthrough (simulated data) | ALL OK, 15 steps |
| `4-backend-gates.log` | fmt, clippy, collector, tests | All exit 0; 99 + 80 + 6 tests; **99.06% lines**, gate 99 |
| `6-frontend-gates.log` | Typecheck, coverage, build | Exit 0; 292 tests; **100%** |
| `5-cross-target-checks.log` | Rust type-checks for arm64 macOS, x64 macOS and Windows | Exit 0. C steps stubbed: **this isn't evidence that they work** |

`peak-cli.rs` joins `main.rs` and `lib.rs` in the coverage exclusion, as a five-line entry point. The 99% gate itself is unchanged.

**Bugs this found, which a successful build wouldn't have.**
- **Commands ran in the wrong directory.** An AppImage's launcher moves into its own mount, so `peak run` ran every command inside the image. Fixed, and now a permanent smoke check.
- **Commands inherited the image's libraries.** `LD_LIBRARY_PATH`, `PATH`, GTK settings and more pointed into the mount, for captured commands, the CLI, `ssh`, `docker` and `kubectl`. Fixed with `runner::host_command`, also a smoke check.
- **A zombie counted as an open app.** Fixed.

**First-release candidate, Linux only, production key.** Built by `scripts/release/build-linux.sh` from the uncommitted tree, version 0.1.0; a dry run, as the real one comes from CI. It carries a `-dirty` commit, so it isn't for publishing.
- `peak_0.1.0_amd64.AppImage` sha256 `2fa4c38a0755a8c62c7e6a83635cf139317568f6a1455ca3f2bc0bf51b1eb312`
- `peak_0.1.0_amd64.deb` sha256 `0a9265ce80a84a65f7accfd3e4c7466dd6fc5e4798b8f6800297eb44b8df8b2f`
- At `/mnt/HC_Volume_107248377/.peak-sysroot/rel-root/home/tester/rc/`. The signature passes the independent check and a different file fails it. `smoke.mjs` passes on this AppImage.
- The two-version proofs use a throwaway key. The production key has never signed anything above 0.1.0, so no valid update exists for anyone to replay.

**What exists for Windows and macOS:** a native sampling backend (`native.rs`), process stopping via `taskkill` on Windows, per-OS data directories, discovery without Linux namespaces, a console `peak-cli.exe`, a user PATH entry from the installer, Node and Python agent paths fixed for Windows, the login shell's PATH on macOS, and Linux collectors for both architectures embedded and linked with Rust's own linker (that link was proven on Linux for x86_64 and aarch64). The README's table says what each platform lacks: handle counts and listening ports, among others, are shown as not tracked rather than as zero.

**Limits that will remain.**
- No WebDriver exists for macOS webviews, so the macOS proof uses builds that press the update buttons on a timer (`VITE_PEAK_E2E_AUTOUPDATE`, absent from release builds). Same plugin and flow, but no eye on the UI beyond a screenshot.
- Remote targets from Windows and macOS can't be proven on CI runners.
- The `.deb` doesn't update itself, on purpose. The plugin's route needs a root prompt that I can't prove here. The app says so.
- Builds are repeatable from a tag, and haven't been shown to be byte-reproducible.
- Real GitHub feed behaviour, such as redirects from `releases/latest/download`, can't be checked until a release exists. Check it first thing after publishing.

**The `tauri-driver` GLIBC line in logs 3 and 8.** It reads "weak version `GLIBC_2.39' not found". `tauri-driver` is a test tool only, never shipped. I'd built it on this Ubuntu 24.04 host and ran it in the 22.04 chroot. A weak version is a warning: the loader carries on. It did run: the steps depend on its sessions, and its `tauri-driver` and `WebKitWebDriver` processes are visible in the chroot, as is its `--help`. It's unrelated to glibc compatibility of Peak's artifacts, which are built on 22.04.

**Signing key.** Generated, password-protected, outside git, mode 600, in a mode 700 directory: `/mnt/HC_Volume_107248377/.peak-signing/` (`peak-updater.key`, `peak-updater.password`, `peak-updater.key.pub`). The public half is in `tauri.conf.json`. **Back it up: losing it strands every installed copy.**

**Disposable environment:** container `peak-release-env` and its chroot have been removed. The signing files were checked unchanged before and after.

## Accepted discovery fix: "the cli keeps saying the app isn't running while it is running"

**Status: accepted and pushed as `a1defaa786fc1d1a1e3da836540368a1ddc78eda`. The user's own failure hasn't been seen directly.**

**The user's answer.** They started through `bun run dev` "but tried with the peak command", a `peak` installed through Task and moved to bin. `bun run dev` is the browser demo, with no real app behind it, so a CLI warning on that path is correct. The phrase could also mean they tried launching the native app with that command, so this isn't conclusively browser-only. The discovery bugs below were reproduced independently and are valid fixes, but they aren't established as this user's cause. The browser demo now says what it is on screen, and real installed GUI and CLI use is part of the release acceptance.

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

**PM:** accept public delivery. Commit `docs/evidence/release/ci-public-rerun-v0.1.0/` and this file when convenient; nothing depends on it.

**Then, on PM's word:** start the Go, Bun and PHP profiling agents, with Flutter as a bounded feasibility look. Not started. Nothing of mine is running.

**Separately:** the updater key and its paired password still need an off-server backup.
