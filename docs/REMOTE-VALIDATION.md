# Remote monitoring: what's been validated, and how

This separates three kinds of evidence, because they mean different things:

- **Live**: real OpenSSH, a real Docker daemon, a real Kubernetes API, real processes.
- **Fixture**: a real collector over pipes, or a hand-played collector, or a stand-in CLI. Good for
  failure timing that's hard to provoke. Not evidence that a real connection works.
- **Mock**: the browser mock's simulated targets. Evidence about the UI only.

Everything live ran against **disposable environments on this machine**. Nothing was run against any
real host, engine or cluster, so anything that depends on a real network or another machine is listed
under [Not validated](#not-validated).

**Latest complete run:** 2026-11-06, 05:29:50-05:38:00 UTC, all checks passed.
Log: [`evidence/20261106T0529Z/verification.log`](evidence/20261106T0529Z/verification.log).
Earlier runs in `evidence/` are kept as a record, including the ones that failed.

## Run it again

```sh
PEAK_TOOLS=<tools dir> scripts/verify-all.sh       # everything, with a dated log in docs/evidence/
task test:live                                     # builds the static collector, runs the three live suites
```

Or individually, with a static collector in `$PEAK_COLLECTORS/x86_64/`:

```sh
cd src-tauri
cargo test --test live_ssh    -- --ignored --test-threads=1 --nocapture
cargo test --test live_docker -- --ignored --test-threads=1 --nocapture
cargo test --test live_kube   -- --ignored --test-threads=1 --nocapture   # needs kubectl on PATH
```

These are `#[ignore]`d, so normal test runs and coverage don't depend on them. They aren't in CI yet.

| Suite | Disposable environment | Cleans up |
|---|---|---|
| `live_ssh` | `sshd` on a free high port, throwaway keys, temp config | Yes |
| `live_docker` | `alpine:3.20` containers named `peak-live-*`, plus a private `sshd` and `DOCKER_CONFIG` for the context test | Yes. Only addresses containers it created |
| `live_kube` | One privileged `rancher/k3s` container named `peak-live-k3s` | Yes |
| `scripts/e2e/desktop/run.sh` | The real binary in an Ubuntu 24.04 container (WebKitGTK, Xvfb, `tauri-driver`, `sshd`, `dunst`), on a private network with an isolated `docker:dind` daemon and one k3s node. It can't see the host's Docker daemon | Yes |

## Correctness requirements

"Live" below names the suite that demonstrates it.

| Requirement | Evidence |
|---|---|
| Reused PIDs can't inherit a run or receive a predecessor's signal | **Live** SSH: reattach requires boot, PID namespace and start ticks. Fixture: mismatch cases; signal refused when start ticks differ (`signals_refuse_a_pid_that_became_another_process`) |
| Reused container names don't inherit | **Live** Docker: a same-named replacement isn't treated as the target (it means the container id) |
| Reused pod names don't inherit | **Live** Kubernetes: replacement detected by UID, refused, history stays with the old pod |
| Disconnect isn't workload exit | **Live** SSH: sessions and listener dropped, run stays `running`, workload untouched. **Live** desktop window: banner shown, process verified alive |
| Gaps are visible | **Live** SSH: gap recorded covering the outage. **Live** desktop window: "No data" band on the memory chart |
| Reconnect revalidates and doesn't duplicate | **Live** SSH: same run id, strictly increasing samples. Fixture: sequence gaps, replay ordering, duplicates |
| A workload that died while disconnected gets no invented exit | **Live** SSH: `ended while disconnected`, no exit code |
| Rates use target-local time | By construction: the collector samples on the target, on a monotonic-anchored clock. Fixture for time remapping across sessions |
| Remote wall time and receipt time stay distinct | Clock offset carried per target and per run, shown in Targets and Stats. **Live** only with identical clocks (see below) |
| Host capacity, container limits and totals labelled separately | **Live** Docker and Kubernetes: `--memory`/`--cpus` and pod limits read from cgroups, separate from host memory. Docker totals labelled as whole-container |
| Missing or inaccessible metrics stay unavailable | **Live** SSH: PID 1 reports `io` and `fds` unreadable. Unknown Docker figures stay "Unknown" (unit) |
| Slow or unreachable targets don't freeze local monitoring | **Live** SSH: black-holed address, worst pass ~100µs while connecting. Fixture: hung connector. Remote I/O never holds the monitor mutex |
| Attached-service logs limited to what's available | **Live** desktop window: "aren't captured here" on an attached run. Container logs labelled as platform logs (**live** Docker, Kubernetes) |
| Exact stdout/stderr only where captured | **Live** SSH, Docker, Kubernetes: launched commands, exact streams and exit codes |
| Signals act on the selected target and verified workload | **Live** SSH and fixture. Attached services have no plain Stop (**live** desktop window) |
| Disconnecting isn't a stop contract; shutdown leaves services alone | **Live** SSH: after `shutdown`, attached process alive, launched commands stopped |
| No implicit local restart | Fixture: attached runs refuse restart; reopened remote runs only run on their own target |
| Runtime instrumentation is explicit | **Live** SSH: agents installed by the collector, CPU profile and snapshot on the target. Attached processes report no agent |
| Permission failures are honest | **Live** SSH: wrong key shows "Permission denied". **Live** Kubernetes: restricted RBAC, Forbidden shown, `can-i` per subresource |
| Minimal images | **Live** Kubernetes: pause image (no `uname`, no `tar`) fails with a clear message; logs still work. **Live** Docker: `--read-only` fails to copy, totals and top still work |
| Remote Docker engines | **Live** path only: a context with `host=ssh://` through a disposable sshd, to this machine's daemon |
| Multiple containers in a pod | **Live** Kubernetes: per-container logs and processes, sidecar not visible from the app container |
| Optional metrics | **Live** Kubernetes: absent reads as "not available"; measured values read from a system pod once metrics-server is up. The API answers NotFound for a running pod it has no data on, and that reads as "no measurement yet" rather than a missing pod |

## Through the real desktop window

`scripts/e2e/desktop/desktop.mjs` drives the real binary over WebDriver, with real backends behind each flow:

- **SSH:** add a target, connect (collector copied over `ssh`), launch with captured output, attach an existing
  process, disconnect, reconnect with a visible gap, detach.
- **Docker:** real daemon. Totals with the container's limit, daemon-view processes, platform logs, connect a
  collector, attach, detach (container left running).
- **Kubernetes:** real API. Pods, per-container logs, collector through `kubectl exec`, cgroup limit shown, attach, detach.
- **Notifications:** see below.

## Notification delivery

- **On Linux the plugin always reports permission as granted, and discards delivery errors.** Peak can't know whether
  a notification appeared, so Settings says "Handed to your desktop's notification service. Peak can't see whether
  it appears", and the test button says "handed over", not "sent".
- **Live, with a real daemon (`dunst`):** the test notification and one alert per crossing arrive, recorded by a hook
  inside dunst: [`notifications-received.log`](evidence/20261106T0529Z/notifications-received.log). No repeat
  while still over the limit. With notifications turned off, the alert shows in the app and the daemon gets nothing.
- **Live, with no notification service:** the app reports what it knows and keeps monitoring.
- **Browser permission refused:** unit-tested only.

## Disconnect contract

Stated in `peak-core/src/collector.rs` and shown in the Capture page.

- **Attached processes** are only ever observed. A lost connection, a disconnect, removing a target and
  quitting peak all leave them running.
- **Commands the collector launched** end with the session: SIGTERM, then SIGKILL after a grace period,
  because their output pipes end with it. This holds whether the session ended by choice or by loss.
  The collector also ends a session after 30s of silence, since SSH can hold a dead connection's stdin open.
- **Durable remote jobs aren't offered.** They'd need a supervisor or a persistent collector.
- A launched run found alive after a reconnect (the old session hadn't noticed yet) continues as
  observed-only, with a log line saying capture ended.

## Not validated

Treat these as open until someone runs them for real.

| Gap | Why it matters |
|---|---|
| SSH to another machine, over a real network | All live SSH was loopback. Latency, packet loss, NAT timeouts and `ServerAlive` behaviour are unproven |
| Differing clocks, and a clock changed mid-run | Live offsets were always ~0. Remapping is fixture-tested only; the system clock wasn't changed |
| A real reboot | Boot-id mismatch is fixture-tested only |
| Arm64 targets | Only `x86_64-unknown-linux-musl` was built. Other architectures report "no peak-collector build" |
| A Docker engine on another machine, Docker Desktop | The `ssh://` context reached this machine's daemon |
| `hidepid` mounts | Unreadable metrics were shown via another user's process, not `hidepid` |
| Images with no shell at all | Direct argv launch is tested, but in images that have a shell |
| Managed Kubernetes, large clusters, cgroup v1 hosts | One k3s node with relaxed disk-eviction thresholds (this machine's disk is nearly full), cgroup v2. cgroup v1 parsing is fixture-tested |
| Notification display on real desktops | Delivery to `dunst` is proven. GNOME, KDE, macOS and Windows weren't run, and whether a popup was actually seen isn't observable here |
| Application pods getting measured metrics | Measured values were only seen for a system pod. New pods stayed unmeasured for over four minutes in one run, with the API answering NotFound. The cause wasn't established, and it may be this single-node, low-disk setup |
| Packaged desktop builds | The window was validated on a debug build with the frontend embedded, under Xvfb with software rendering. No installer has been built or run |
| Installers | The collector isn't bundled yet; the app finds it through `PEAK_COLLECTORS` or `collectors/<arch>/` beside its binary (`task collector:build`) |

## Deliberately not built

From the research document's "later" options: ephemeral debug containers, sidecars with process namespace
sharing, node DaemonSets, listener-based collectors with port-forward, and native Docker/Kubernetes API
clients. Container-wide kill isn't offered either; only verified per-process signals are.
