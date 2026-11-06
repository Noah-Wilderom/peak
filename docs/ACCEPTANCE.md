# Peak feature acceptance

PM checklist derived from `HANDOFF.md`, `remote-monitoring-research.md`, and
Peak's use of `../DESIGN.md`. This defines user outcomes and evidence, not
implementation choices. No item is accepted merely because a developer turn ends.
The full eleven-milestone scope remains required.

## Evidence required for every milestone

- Delivered user flow, including relevant desktop behavior and browser mock parity.
- Meaningful validation for the changed behavior and preserved existing behavior.
- Exact check results, with environment failures distinguished from product failures.
- No weakened coverage thresholds, skipped failures, fabricated metrics, or
  claims of live integration based only on a mock.
- An updated handoff and a clear delivered/pending/live-validation distinction.

The handoff's validation contract is frontend typecheck, coverage and build;
backend formatting, clippy with warnings denied, tests and coverage; and Node/Python
agent tests. Frontend coverage remains 100% for all enforced metrics and backend
coverage remains at or above its 99% CI line gate. Run checks appropriate to each
milestone and the complete required suite before final acceptance. Historical
baseline numbers do not establish that a new feature passes.

Authoritative CI contract checked against `.github/workflows/test.yml` on
2026-11-05:

| Area | Required evidence |
|---|---|
| Frontend | Frozen-lockfile install, typecheck, full coverage run with the existing 100% gates, and production build |
| Backend | Frontend built first, formatting check, clippy across all targets with warnings denied, and llvm-cov with `--fail-under-lines 99` using the existing exclusions for lib.rs and main.rs |
| Agents | Node 20 and 22 CI matrix; Node test suite and Python 3.12 unittest discovery |

Local results on another runtime are useful additional evidence, but do not
replace the declared supported-runtime matrix. An environment/setup failure is
tracked separately and does not waive the corresponding gate.

## 1. Runtime agents

- Node and Python report runtime lag through the existing monitoring experience.
- Both runtimes can produce a CPU profile for a requested duration.
- Profiles contain interpretable call-tree timing data and coexist with existing
  heap/GC/snapshot behavior.
- Agent test evidence covers the new behavior in both runtimes.

## 2. History

- Stored runs can be browsed by command and searched.
- Opening a stored run makes it available in the session without confusing it
  with a newly launched workload.
- Deleting history and selecting runs for comparison work predictably.
- Historical data survives application restarts; the mock includes historical runs.

## 3. Settings

- Retention days, maximum runs, alert thresholds, notifications and theme can be
  inspected and changed; saved settings survive restart where supported.
- Storage usage is visible and updates after storage maintenance.
- Pruning by age, pruning stopped runs, and vacuuming are usable, with clear scope
  and outcomes. Maintenance must not stop active workloads or corrupt their data.

## 4. Run comparison

- Two selected runs can be compared with memory curves aligned at elapsed T+0.
- Peak memory, duration and average CPU differences are visible with clear units.
- Comparison does not silently add compared runs to the active session.
- Unequal run lengths and unavailable data remain interpretable.

## 5. Run report

- A report includes verdict, peak, duration, exit information, GC share, top
  allocators from the latest available snapshot, and alerts.
- Markdown and JSON copies contain the reported run's information.
- Missing snapshots/GC and still-running or interrupted runs are represented honestly.

## 6. Timeline and output navigation

- Memory-chart markers represent stderr, major GCs, snapshots and alerts.
- Clicking an event opens the relevant output time; chart zoom gestures retain
  their existing behavior.
- Events and logs stay associated with the correct run and time range.

## 7. Alerts

- Memory thresholds and sustained CPU thresholds use the saved configuration.
- Alerts produce a toast, a timeline marker and a native notification when enabled
  and permitted.
- Duration semantics are verified; threshold crossings do not produce an
  uncontrolled stream of duplicate notifications.
- Disabling notifications or lacking native permission does not break monitoring.

## 8. Resources

- The Resources tab replaces Processes and provides child memory, thread/handle
  history, listening ports, the child table and runtime lag.
- Per-child series and totals remain distinguishable; data unavailable for a
  runtime/process is not presented as a measured zero.

## 9. Machine context

- The sidebar strip and machine chart expose memory, swap, pressure, load and CPU
  data available from the machine samples.
- Users can distinguish process usage from host pressure/capacity.
- Machine history remains bounded and labels identify its scope.

## 10. CPU profile UI

- Supported runtimes offer 5-second and 10-second recordings in Profiler.
- Recording progress, success and unsupported/error outcomes are understandable.
- Completed CPU profiles render with time values, while existing heap views retain
  correct byte values.
- Stored profiles can be viewed with the appropriate run.

## 11. Remote monitoring

User-selected validation environment: disposable local test environments where
possible. Keep them isolated and non-production. Record what was actually tested
live and any remaining environment limitations.

Accept the stages in the research document's order and retain all stages in scope:

- Target model for local, SSH, Docker and Kubernetes, with connection state and
  capabilities that accurately govern available actions.
- Independently runnable headless collector and a versioned protocol.
- SSH process discovery/attachment and detailed observation.
- Docker context/container discovery, observation, logs, aggregate fallback, and
  detailed collection for prepared containers.
- Kubernetes context/namespace/pod/container discovery, logs, optional aggregate
  metrics and detailed collection for prepared containers.
- Target-routed launch, control and profiling after observation is reliable.

Required correctness evidence:

- Reused PIDs, container replacements and reused pod names cannot inherit the wrong
  history or receive a predecessor's control action.
- Disconnect is distinct from workload exit; gaps are visible and reconnect
  revalidates identity and synchronizes data without duplicates.
- Rates use target-local elapsed time; remote wall time and desktop receipt time
  remain distinguishable.
- Host capacity, container limits/totals and process-tree metrics are labeled
  separately. Missing or inaccessible metrics remain unavailable.
- Slow or unreachable remote targets do not freeze local monitoring.
- Attached-service logs are limited to the sources actually available; exact
  stdout/stderr is promised only where the product actually captures it.
- Signals, restart and profiling act on the selected target and verified workload.
  Disconnecting a transport is not a remote stop contract. Existing services are
  not killed on desktop shutdown or implicitly restarted locally.
- Runtime instrumentation support is explicit; transport access alone does not
  claim heap/GC/profiling capability.
- Permission failures, incompatible/minimal images, remote engines, multiple
  containers and optional platform services have honest failure/fallback behavior.
- Tests/fixtures and real SSH/Docker/Kubernetes validation are reported separately.
  An unavailable live environment is a validation gap, not proof of success.

## Cross-cutting product checks

Preserve binary byte units, dark mode, readable charts, the established monochrome
and pill-control design, semantic status colors, focus visibility and usable
layouts. Use the existing Peak interpretation of DESIGN.md; do not import
unrelated marketing-site content or redesign the application as part of this work.
Keep local capture, attach, CLI, process lifecycle, logs, heap snapshots and GC
working throughout remote development.

## PM acceptance — 2026-11-06 05:50:41 UTC

All eleven milestones are accepted for the original development scope. The PM
inspected the complete milestone/evidence matrix in `DEVELOPMENT-STATUS.md`, the
final 05:29–05:38 verification log, notification receipts, supplemental frozen-lock
and Python 3.12 logs, current CI/coverage policy, and unchanged product/dependency
hashes. Representative real-desktop target and dark browser screenshots were also
inspected for readable layouts, neutral surfaces, pill controls and status colors.
The PM did not execute tests or inspect implementation code.

Evidence:

- `evidence/20261106T0529Z/verification.log`: all stages pass; 213 frontend tests
  with all four coverage metrics at 100%; 150 backend tests at 99.19% lines;
  formatting, clippy, builds, Node 20/22, disposable SSH/Docker/Kubernetes, eleven
  browser flows and twenty-four real desktop steps.
- `evidence/20261106T0529Z/notifications-received.log`: actual daemon receipt.
- `evidence/supplement-20261106T0544Z/3-after-test-import-fix.log`: frozen install
  succeeds without changing dependency files; an unlocked-dependency control is
  refused; Python 3.12.3 and 3.12.16 pass all eight agent tests, and the existing
  Node/Python suite passes after the isolated test-import correction.
- `REMOTE-VALIDATION.md`: maps remote correctness requirements to explicit live,
  fixture and mock evidence. The developer's final milestone table maps each of
  the eleven product outcomes to appropriate test/UI evidence.

Validation used disposable local environments as selected by the user. Real
other-machine networks/clocks/reboots, arm64, managed/large clusters, application
pod metric availability, native desktop shells and packaged installers remain
explicit limits. No production deployment, release packaging, commit or push was
claimed or performed. These limits are preserved as follow-up work in the handoff.

