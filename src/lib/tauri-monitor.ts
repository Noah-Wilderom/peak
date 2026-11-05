import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { MonitorApi } from "@/lib/monitor-api"
import {
  MAX_SAMPLES,
  type Attachable,
  type ChildProc,
  type Counters,
  type GcEvent,
  type HeapSnapshot,
  type LogLine,
  type MonitorEvent,
  type Proc,
  type Sample,
  type State,
  type SystemInfo,
  type SystemSample,
} from "@/lib/types"

const MAX_LOGS = 2000
const MAX_GC = 3000

/** Incremental update for one process, emitted by the backend every tick. */
export interface ProcDelta {
  id: string
  samples: Sample[]
  logs: LogLine[]
  gc: GcEvent[]
  status: Proc["status"]
  endedAt?: number
  exitCode?: number
  signal?: string
  runtime: Proc["runtime"]
  exe: string
  ppid: number
  nice: number
  threads: number
  vsz: number
  swap: number
  fds: Proc["fds"]
  counters: Counters
  peak: Sample
  children: ChildProc[]
  hasGc: boolean
  profiling: boolean
  childNames?: Proc["childNames"]
  ports?: Proc["ports"]
}

/** What the backend emits on `peak://tick`. */
export interface TickPayload {
  procs: ProcDelta[]
  system: SystemSample | null
}

export interface FullState {
  procs: Proc[]
  system: SystemInfo
}

function append<T>(xs: T[], add: T[], max: number) {
  if (!add.length) return xs
  const out = xs.concat(add)
  return out.length > max ? out.slice(out.length - max) : out
}

const EMPTY_SAMPLE: Omit<Sample, "t"> = {
  rss: 0, heap: 0, heapTotal: 0, external: 0, code: 0, stack: 0,
  cpu: 0, cpuUser: 0, cpuSys: 0, read: 0, write: 0, alloc: 0, faults: 0,
}

/** The UI relies on every process having at least one sample. */
export function normalizeProc(p: Proc): Proc {
  if (p.samples.length) return p
  const s = { t: p.startedAt, ...EMPTY_SAMPLE }
  return { ...p, samples: [s], peak: p.peak ?? s }
}

/** Pure merge of a backend delta into a process (exported for tests). */
export function applyDelta(p: Proc, d: ProcDelta): Proc {
  // A delta can overlap the full state fetched at startup; skip what we have.
  const lastT = p.samples.at(-1)!.t // processes are normalized on arrival
  const lastLog = p.logs.at(-1)?.id ?? -Infinity
  const lastGc = p.gc.at(-1)?.t ?? -Infinity
  return {
    ...p,
    samples: append(p.samples, d.samples.filter((s) => s.t > lastT), MAX_SAMPLES),
    logs: append(p.logs, d.logs.filter((l) => l.id > lastLog), MAX_LOGS),
    gc: append(p.gc, d.gc.filter((g) => g.t > lastGc), MAX_GC),
    status: d.status,
    endedAt: d.endedAt,
    exitCode: d.exitCode,
    signal: d.signal,
    runtime: d.runtime,
    exe: d.exe,
    ppid: d.ppid,
    nice: d.nice,
    threads: d.threads,
    vsz: d.vsz,
    swap: d.swap,
    fds: d.fds,
    counters: d.counters,
    peak: d.peak,
    children: d.children,
    hasGc: d.hasGc,
    profiling: d.profiling,
    childNames: d.childNames,
    ports: d.ports,
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type Listen = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>

export class TauriMonitor implements MonitorApi {
  readonly mode = "tauri" as const
  private state: State = {
    procs: [],
    selectedId: null,
    paused: false,
    system: { totalMemory: 1, cpus: 1, hostname: "", os: "" },
    ready: false,
  }
  /** While paused, deltas are applied here and the visible state stays put. */
  private hidden: Proc[] | null = null
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: MonitorEvent) => void>()
  private started = false

  constructor(
    private readonly call: Invoke = invoke as Invoke,
    private readonly on: Listen = listen as unknown as Listen,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    void this.start()
    return () => void this.listeners.delete(l)
  }

  getSnapshot = () => this.state

  onEvent = (l: (e: MonitorEvent) => void) => {
    this.eventListeners.add(l)
    return () => void this.eventListeners.delete(l)
  }

  private set(next: Partial<State>) {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((l) => l())
  }

  private emit(e: MonitorEvent) {
    this.eventListeners.forEach((l) => l(e))
  }

  private current() {
    return this.hidden ?? this.state.procs
  }

  private commit(procs: Proc[], extra: Partial<State> = {}) {
    if (this.state.paused) {
      this.hidden = procs
      if (Object.keys(extra).length) this.set(extra)
    } else {
      this.set({ procs, ...extra })
    }
  }

  async start() {
    if (this.started) return
    this.started = true
    try {
      await this.on<TickPayload>("peak://tick", (e) => this.onTick(e.payload))
      await this.on<Proc>("peak://proc", (e) => this.upsert(e.payload, true))
      const full = await this.call<FullState>("get_state")
      this.set({
        procs: full.procs.map(normalizeProc),
        system: full.system,
        selectedId: this.state.selectedId ?? full.procs[0]?.id ?? null,
        ready: true,
      })
    } catch (err) {
      this.set({ ready: true, error: String(err) })
    }
  }

  onTick({ procs: deltas, system }: TickPayload) {
    if (system) this.state = { ...this.state, machine: append(this.state.machine ?? [], [system], MAX_SAMPLES) }
    const byId = new Map(deltas.map((d) => [d.id, d]))
    const events: MonitorEvent[] = []
    const procs = this.current().map((p) => {
      const d = byId.get(p.id)
      if (!d) return p
      const next = applyDelta(p, d)
      if (p.status === "running" && next.status !== "running") {
        events.push({ type: next.status === "crashed" ? "crashed" : "exited", proc: next })
      }
      return next
    })
    this.commit(procs)
    events.forEach((e) => this.emit(e))
  }

  private upsert(raw: Proc, announce: boolean) {
    const proc = normalizeProc(raw)
    const exists = this.current().some((p) => p.id === proc.id)
    const procs = exists ? this.current().map((p) => (p.id === proc.id ? proc : p)) : [proc, ...this.current()]
    this.commit(procs, { selectedId: proc.id })
    if (announce && !exists) this.emit({ type: "captured", proc })
  }

  // ─── actions ───

  select = (id: string) => this.set({ selectedId: id })

  setPaused = (paused: boolean) => {
    if (!paused && this.hidden) {
      const procs = this.hidden
      this.hidden = null
      this.set({ paused, procs })
    } else {
      this.set({ paused })
    }
  }

  capture = async (command: string, cwd: string) => {
    this.upsert(await this.call<Proc>("capture", { command, cwd }), true)
  }

  attach = async (pid: number) => {
    this.upsert(await this.call<Proc>("attach", { pid }), true)
  }

  listAttachable = () => this.call<Attachable[]>("list_attachable")

  takeSnapshot = async (id: string) => {
    const snapshot = await this.call<HeapSnapshot>("take_snapshot", { id })
    const procs = this.current().map((p) => (p.id === id ? { ...p, snapshots: [...p.snapshots, snapshot] } : p))
    this.commit(procs)
    const proc = procs.find((p) => p.id === id)
    if (proc) this.emit({ type: "snapshot", proc, snapshot })
    return snapshot
  }

  forceGc = (id: string) => void this.call("force_gc", { id }).catch(this.fail)

  kill = (id: string) => void this.call("stop", { id }).catch(this.fail)

  restart = (id: string) => {
    void this.call<Proc>("restart", { id })
      .then((raw) => {
        const proc = normalizeProc(raw)
        const procs = this.current().map((p) => (p.id === id ? proc : p))
        this.commit(procs, { selectedId: proc.id })
      })
      .catch(this.fail)
  }

  remove = (id: string) => {
    void this.call("remove", { id }).catch(this.fail)
    const procs = this.current().filter((p) => p.id !== id)
    const selectedId = this.state.selectedId === id ? (procs[0]?.id ?? null) : this.state.selectedId
    this.commit(procs, { selectedId })
  }

  clearEnded = () => {
    void this.call("clear_ended").catch(this.fail)
    const procs = this.current().filter((p) => p.status === "running")
    const selectedId = procs.some((p) => p.id === this.state.selectedId) ? this.state.selectedId : (procs[0]?.id ?? null)
    this.commit(procs, { selectedId })
  }

  private fail = (err: unknown) => this.set({ error: String(err) })
}
