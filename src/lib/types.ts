/**
 * The data model shared by the mock monitor and the Tauri backend.
 * Mirrors the serde structs in `src-tauri/src/model.rs`.
 */

export const TICK_MS = 500
export const SYSTEM_MEMORY = 32 * 1024 ** 3
export const MAX_SAMPLES = 7200 // 1 hour of history at 500ms

export type Runtime = "node" | "bun" | "python" | "rust" | "go" | "shell"
export type Status = "running" | "exited" | "crashed"

export interface Sample {
  t: number
  /** Resident set size. */
  rss: number
  /** Live objects on the managed heap (or malloc'd bytes for native code). */
  heap: number
  /** Heap reserved from the OS. */
  heapTotal: number
  /** Off-heap buffers: ArrayBuffers, tensors, mmaps. */
  external: number
  code: number
  stack: number
  /** CPU % across all cores (100 = one core). */
  cpu: number
  cpuUser: number
  cpuSys: number
  /** Bytes/s. */
  read: number
  write: number
  /** Bytes allocated per second. */
  alloc: number
  /** Minor page faults per second. */
  faults: number
  // Newer backends also report these (optional so older data still loads).
  threads?: number
  files?: number
  sockets?: number
  pipes?: number
  /** Node event-loop / Python interpreter delay, p99 ms. */
  loopLag?: number
  kids?: { pid: number; rss: number; cpu: number }[]
}

/** Numeric metrics every sample has (excludes the optional newer fields). */
export type MetricKey = {
  [K in keyof Sample]-?: undefined extends Sample[K] ? never : Sample[K] extends number ? K : never
}[keyof Sample]

/** Machine-wide context sampled alongside processes. */
export interface SystemSample {
  t: number
  memTotal: number
  memAvailable: number
  swapTotal: number
  swapFree: number
  /** Memory pressure, % of time stalled. Null where the kernel doesn't report it. */
  psiSome: number | null
  psiFull: number | null
  load1: number
  cpu: number
}

export interface GcEvent {
  t: number
  kind: "minor" | "major"
  pauseMs: number
  freed: number
}

export interface HeapEntry {
  name: string
  count: number
  shallow: number
  retained: number
}

export interface AllocFrame {
  name: string
  file?: string
  /** In this frame itself: bytes for heap sites, sampled milliseconds for CPU profiles. */
  self: number
  children: AllocFrame[]
}

export interface HeapSnapshot {
  id: string
  t: number
  heapUsed: number
  entries: HeapEntry[]
  sites: AllocFrame
}

export interface LogLine {
  id: number
  t: number
  stream: "stdout" | "stderr"
  text: string
}

export interface ChildProc {
  pid: number
  name: string
  cpu: number
  rss: number
}

export interface Counters {
  cpuUserMs: number
  cpuSysMs: number
  minorFaults: number
  majorFaults: number
  ctxVoluntary: number
  ctxInvoluntary: number
  readTotal: number
  writeTotal: number
  syscalls: number
}

export interface Proc {
  id: string
  pid: number
  ppid: number
  user: string
  exe: string
  command: string
  cwd: string
  runtime: Runtime
  status: Status
  startedAt: number
  endedAt?: number
  exitCode?: number
  signal?: string
  nice: number
  threads: number
  vsz: number
  swap: number
  fds: { files: number; sockets: number; pipes: number }
  counters: Counters
  samples: Sample[]
  peak: Sample
  gc: GcEvent[]
  hasGc: boolean
  /** Whether heap snapshots / allocation sampling are available (runtime agent attached). */
  profiling: boolean
  snapshots: HeapSnapshot[]
  logs: LogLine[]
  children: ChildProc[]
  childNames?: Record<string, string>
  ports?: { port: number; proto: string; addr: string; pid: number }[]
  cpuProfiles?: CpuProfile[]
  alerts?: Alert[]
  /** Reopened from stored history, as opposed to monitored in this session. */
  historical?: boolean
  /** Metrics that couldn't be read ("io", "fds"): their values mean unknown, not zero. */
  unavailable?: string[]
  /** Where this run lives, when it isn't on this machine. */
  target?: ProcTarget
  /** Stretches with no data because the connection was lost. */
  gaps?: Gap[]
}

export type TargetKind = "local" | "ssh" | "docker" | "kubernetes"
/** The link to a target. Independent of whether any workload is running. */
export type ConnectionState = "connecting" | "connected" | "stale" | "disconnected" | "failed"

export interface Gap {
  from: number
  to: number
}

export interface LaunchSpec {
  /** Shell command line (requires /bin/sh on the target). */
  command?: string
  /** Direct executable and arguments, for images without a shell. */
  argv?: string[]
  cwd: string
}

/** What makes a workload that workload: PIDs get reused. */
export interface ProcIdentity {
  bootId: string
  pidNs: string
  pid: number
  startTicks: number
  containerId?: string
  podUid?: string
}

export interface ProcTarget {
  targetId: string
  label: string
  kind: TargetKind
  identity: ProcIdentity
  /** Launched by the collector (output captured, restartable). Otherwise only observed. */
  launched: boolean
  spec?: LaunchSpec
  /** This machine's clock minus the target's, at the last frame. */
  clockOffsetMs: number
}

export interface Capabilities {
  collector: boolean
  attach: boolean
  launch: boolean
  signal: boolean
  runtimeAgents: boolean
  containerTotals: boolean
  containerLogs: boolean
  containerTop: boolean
}

export interface TargetSpec {
  id: string
  label: string
  kind: TargetKind | null
  /** SSH destination, as `ssh` would take it. */
  host: string
  port: number | null
  /** Docker or Kubernetes context ("" is the current one). */
  context: string
  /** Docker container id, or Kubernetes pod name. */
  container: string
  namespace: string
  podContainer: string
  /** The pod instance meant. A new pod with the same name is a different target. */
  podUid: string
  collectorPath: string
  /** May peak copy the collector over if it's missing? */
  install: boolean
}

export interface CgroupLimits {
  version: number | null
  memoryMax: number | null
  memoryCurrent: number | null
  cpuQuotaCores: number | null
}

export interface TargetFacts {
  protocol: number
  collectorVersion: string
  arch: string
  kernel: string
  hostname: string
  bootId: string
  pidNs: string
  uid: number
  clkTck: number
  cpus: number
  /** The machine's memory, from /proc/meminfo. Not the container's limit. */
  hostMemory: number
  limits: CgroupLimits
  runtimeAgents: boolean
}

export interface TargetState {
  spec: TargetSpec
  state: ConnectionState
  error: string | null
  capabilities: Capabilities
  facts: TargetFacts | null
  /** Whole-host figures from the target, not any process. */
  system: SystemSample | null
  clockOffsetMs: number
}

export const NEW_TARGET: TargetSpec = {
  id: "", label: "", kind: null, host: "", port: null, context: "", container: "", namespace: "", podContainer: "", podUid: "", collectorPath: "", install: false,
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
}

/** Container-wide figures. A different series from a process tree. */
export interface ContainerTotals {
  cpuPercent: number | null
  memoryUsed: number | null
  memoryLimit: number | null
  pids: number | null
  rawNet: string
  rawBlock: string
}

export interface ContainerProcess {
  /** As the daemon sees it, not the PID inside the container. */
  pid: string
  user: string
  command: string
}

export interface KubeContainer {
  name: string
  ready: boolean
  state: string
  restarts: number
  containerId: string
}

export interface KubePod {
  name: string
  uid: string
  namespace: string
  phase: string
  node: string
  containers: KubeContainer[]
}

export interface KubeMetrics {
  container: string
  cpu: string
  memory: string
}

export interface KubeAccess {
  listPods: boolean
  readLogs: boolean
  exec: boolean
}

/**
 * How a CPU profile's stacks were collected. Neither is strict on-CPU time:
 * - "v8": V8's sampler. Waiting in the event loop shows as a separate (idle)
 *   frame, but synchronous blocking is charged to the frame that made the call.
 * - "stack": the thread's stack is sampled on a timer whether or not it was
 *   running, so sleeps, I/O and lock waits all count.
 */
export type CpuSampling = "v8" | "stack" | "unknown"

/** A sampled call tree; `self` is the milliseconds of samples landing in that frame. */
export interface CpuProfile {
  id: string
  t: number
  durationMs: number
  sampling?: CpuSampling
  root: AllocFrame
}

/** A threshold crossing recorded on a run. */
export interface Alert {
  t: number
  kind: "memory" | "cpu"
  message: string
  value: number
  threshold: number
}

/** A stored run, as listed by history. */
export interface RunSummary {
  id: string
  pid: number
  command: string
  cwd: string
  runtime: Runtime
  status: Status
  startedAt: number
  endedAt?: number | null
  exitCode?: number | null
  signal?: string | null
  peakRss: number
  avgCpu: number
  samples: number
}

export interface StorageInfo {
  path: string
  bytes: number
  runs: number
  stoppedRuns: number
  samples: number
}

export interface Settings {
  /** Stopped runs older than this are pruned automatically (0 = keep forever). */
  retentionDays: number
  /** Keep at most this many stopped runs (0 = unlimited). */
  maxRuns: number
  alertsEnabled: boolean
  notifications: boolean
  /** Alert when resident memory exceeds this many MiB (0 = off). */
  alertMemoryMib: number
  /** Alert when CPU stays above this % ... */
  alertCpuPercent: number
  /** ... for this many seconds (0 = off). */
  alertCpuSeconds: number
}

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 30,
  maxRuns: 500,
  alertsEnabled: true,
  notifications: true,
  alertMemoryMib: 0,
  alertCpuPercent: 90,
  alertCpuSeconds: 0,
}

export interface SystemInfo {
  totalMemory: number
  cpus: number
  hostname: string
  os: string
}

export interface State {
  procs: Proc[]
  selectedId: string | null
  paused: boolean
  system: SystemInfo
  /** False until the backend has sent its first full state. */
  ready: boolean
  /** Recent machine-wide samples, oldest first. */
  machine: SystemSample[]
  /** Other machines and containers peak knows about. */
  targets: TargetState[]
  error?: string
}

export type MonitorEvent =
  | { type: "exited"; proc: Proc }
  | { type: "crashed"; proc: Proc }
  | { type: "captured"; proc: Proc }
  | { type: "snapshot"; proc: Proc; snapshot: HeapSnapshot }
  | { type: "alert"; proc: Proc; alert: Alert; notify: boolean }

export interface Attachable {
  pid: number
  command: string
  cwd: string
  rss: number
  /** Identifies this process among any that reuse its PID. */
  startTicks?: number
}

export function frameTotal(f: AllocFrame): number {
  return f.self + f.children.reduce((s, c) => s + frameTotal(c), 0)
}
