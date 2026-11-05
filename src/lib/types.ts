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
  psiSome: number
  psiFull: number
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
  /** Bytes allocated directly in this frame. */
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
  /** Recent machine-wide samples (Tauri backend only). */
  machine?: SystemSample[]
  error?: string
}

export type MonitorEvent =
  | { type: "exited"; proc: Proc }
  | { type: "crashed"; proc: Proc }
  | { type: "captured"; proc: Proc }
  | { type: "snapshot"; proc: Proc; snapshot: HeapSnapshot }

export interface Attachable {
  pid: number
  command: string
  cwd: string
  rss: number
}

export function frameTotal(f: AllocFrame): number {
  return f.self + f.children.reduce((s, c) => s + frameTotal(c), 0)
}
