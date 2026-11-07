import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { AlertEngine, applyAlerts } from "@/lib/alerts"
import type { MonitorApi } from "@/lib/monitor-api"
import {
  DEFAULT_SETTINGS,
  MAX_SAMPLES,
  type Attachable,
  type ChildProc,
  type ContainerProcess,
  type ContainerTotals,
  type Counters,
  type CpuProfile,
  type DockerContainer,
  type Gap,
  type GcEvent,
  type HeapSnapshot,
  type KubeAccess,
  type KubeMetrics,
  type KubePod,
  type LaunchSpec,
  type LogLine,
  type MonitorEvent,
  type Proc,
  type RunSummary,
  type Sample,
  type Settings,
  type State,
  type StorageInfo,
  type SystemInfo,
  type SystemSample,
  type TargetSpec,
  type TargetState,
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
  agent?: Proc["agent"]
  childNames?: Proc["childNames"]
  ports?: Proc["ports"]
  unavailable?: string[]
  gaps?: Gap[]
  clockOffsetMs?: number
}

/** What the backend emits on `peak://tick`. */
export interface TickPayload {
  procs: ProcDelta[]
  system: SystemSample | null
  /** Present when any target exists: connection state and its latest figures. */
  targets?: TargetState[]
}

export interface FullState {
  procs: Proc[]
  system: SystemInfo
  targets?: TargetState[]
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
    agent: d.agent,
    childNames: d.childNames,
    ports: d.ports,
    unavailable: d.unavailable,
    gaps: d.gaps ?? p.gaps,
    target: p.target && d.clockOffsetMs !== undefined ? { ...p.target, clockOffsetMs: d.clockOffsetMs } : p.target,
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
    machine: [],
    targets: [],
  }
  /** While paused, deltas are applied here and the visible state stays put. */
  private hidden: Proc[] | null = null
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: MonitorEvent) => void>()
  private started = false
  private alerts = new AlertEngine()

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
      await this.on<string>("peak://open", (e) => this.open(e.payload))
      await this.on<Proc>("peak://results", (e) => this.refresh(e.payload))
      // Thresholds are a nicety: if they can't be read, monitoring still starts.
      this.alerts.configure(await this.call<Settings>("get_settings").catch(() => DEFAULT_SETTINGS))
      const full = await this.call<FullState>("get_state")
      this.set({
        procs: full.procs.map(normalizeProc),
        system: full.system,
        targets: full.targets ?? [],
        selectedId: this.state.selectedId ?? full.procs[0]?.id ?? null,
        ready: true,
      })
    } catch (err) {
      this.set({ ready: true, error: String(err) })
    }
  }

  onTick({ procs: deltas, system, targets }: TickPayload) {
    if (targets) this.state = { ...this.state, targets }
    if (system) this.state = { ...this.state, machine: append(this.state.machine, [system], MAX_SAMPLES) }
    const byId = new Map(deltas.map((d) => [d.id, d]))
    const events: MonitorEvent[] = []
    const updated = this.current().map((p) => {
      const d = byId.get(p.id)
      if (!d) return p
      const next = applyDelta(p, d)
      if (p.status === "running" && next.status !== "running") {
        events.push({ type: next.status === "crashed" ? "crashed" : "exited", proc: next })
      }
      return next
    })
    const procs = applyAlerts(this.alerts, updated, (proc, alert) => {
      events.push({ type: "alert", proc, alert, notify: this.alerts.notifications })
      void this.call("add_alert", { id: proc.id, alert }).catch(this.fail)
    })
    this.commit(procs)
    events.forEach((e) => this.emit(e))
  }

  /** New results on a run, from `peak profile`. Whatever the person is looking at stays selected. */
  private refresh(raw: Proc) {
    const proc = normalizeProc(raw)
    this.commit(this.current().map((p) => (p.id === proc.id ? proc : p)))
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

  open = (id: string) => this.set({ selectedId: id, openRequest: { id, seq: (this.state.openRequest?.seq ?? 0) + 1 } })

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

  cpuProfile = async (id: string, ms: number) => {
    const profile = await this.call<CpuProfile>("cpu_profile", { id, ms })
    const add = (p: Proc) => (p.id === id ? { ...p, cpuProfiles: [...(p.cpuProfiles ?? []), profile] } : p)
    this.commit(this.current().map(add))
    return profile
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
    this.drop((p) => p.id !== id)
  }

  clearEnded = () => {
    void this.call("clear_ended").catch(this.fail)
    this.drop((p) => p.status === "running")
  }

  // ─── history ───

  listRuns = (query?: string) => this.call<RunSummary[]>("list_runs", { query: query || null })

  openRun = async (id: string) => {
    this.upsert(await this.call<Proc>("open_run", { id }), false)
  }

  loadRun = async (id: string) => normalizeProc(await this.call<Proc>("load_run", { id }))

  deleteRun = async (id: string) => {
    const deleted = await this.call<boolean>("delete_run", { id })
    this.drop((p) => p.id !== id)
    return deleted
  }

  pruneRuns = async (olderThanDays?: number) => {
    const removed = await this.call<number>("prune_runs", { olderThanDays: olderThanDays ?? null })
    // The backend clears ended runs from the session only when pruning everything.
    if (olderThanDays === undefined) this.drop((p) => p.status === "running")
    return removed
  }

  /** Keep only matching processes, moving the selection if it was dropped. */
  private drop(keep: (p: Proc) => boolean) {
    const procs = this.current().filter(keep)
    const selectedId = procs.some((p) => p.id === this.state.selectedId) ? this.state.selectedId : (procs[0]?.id ?? null)
    this.commit(procs, { selectedId })
  }

  // ─── settings and storage ───

  storageInfo = () => this.call<StorageInfo>("storage_info")

  vacuum = () => this.call<void>("vacuum")

  getSettings = () => this.call<Settings>("get_settings")

  setSettings = async (settings: Settings) => {
    const stored = await this.call<Settings>("set_settings", { settings })
    this.alerts.configure(stored)
    return stored
  }

  // ─── targets ───

  addTarget = async (spec: TargetSpec) => {
    const added = await this.call<TargetState>("add_target", { spec })
    const others = this.state.targets.filter((t) => t.spec.id !== added.spec.id)
    this.set({ targets: [...others, added] })
    return added
  }

  removeTarget = async (id: string) => {
    await this.call("remove_target", { id })
    this.set({ targets: this.state.targets.filter((t) => t.spec.id !== id) })
  }

  connectTarget = async (id: string) => void (await this.call("connect_target", { id }))

  disconnectTarget = async (id: string) => void (await this.call("disconnect_target", { id }))

  listTargetProcesses = (id: string) => this.call<Attachable[]>("list_target_processes", { id })

  attachTarget = async (id: string, pid: number) => {
    this.upsert(await this.call<Proc>("attach_target", { id, pid }), true)
  }

  launchTarget = async (id: string, spec: LaunchSpec) => {
    this.upsert(await this.call<Proc>("launch_target", { id, spec }), true)
  }

  detach = async (id: string) => void (await this.call("detach", { id }))

  signal = async (id: string, signal: string) => void (await this.call("signal_run", { id, signal }))

  dockerContexts = () => this.call<string[]>("docker_contexts")

  dockerContainers = (context: string) => this.call<DockerContainer[]>("docker_containers", { context })

  dockerTotals = (context: string, id: string) => this.call<ContainerTotals | null>("docker_totals", { context, id })

  dockerTop = (context: string, id: string) => this.call<ContainerProcess[]>("docker_top", { context, id })

  dockerLogs = (context: string, id: string, tail: number) => this.call<string>("docker_logs", { context, id, tail })

  kubeContexts = () => this.call<string[]>("kube_contexts")

  kubeNamespaces = (context: string) => this.call<string[]>("kube_namespaces", { context })

  kubePods = (context: string, namespace: string) => this.call<KubePod[]>("kube_pods", { context, namespace })

  kubeLogs = (context: string, namespace: string, pod: string, container: string, tail: number) =>
    this.call<string>("kube_logs", { context, namespace, pod, container, tail })

  kubeMetrics = (context: string, namespace: string, pod: string) =>
    this.call<KubeMetrics[] | null>("kube_metrics", { context, namespace, pod })

  kubeAccess = (context: string, namespace: string) => this.call<KubeAccess>("kube_access", { context, namespace })

  private fail = (err: unknown) => this.set({ error: String(err) })
}
