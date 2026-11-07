import type {
  Attachable,
  ContainerProcess,
  ContainerTotals,
  CpuProfile,
  DockerContainer,
  HeapSnapshot,
  KubeAccess,
  KubeMetrics,
  KubePod,
  LaunchSpec,
  MonitorEvent,
  Proc,
  RunSummary,
  Settings,
  State,
  StorageInfo,
  TargetSpec,
  TargetState,
} from "@/lib/types"

/** What the UI needs from a monitor — implemented by the mock and the Tauri backend. */
export interface MonitorApi {
  readonly mode: "mock" | "tauri"
  subscribe(listener: () => void): () => void
  getSnapshot(): State
  onEvent(listener: (e: MonitorEvent) => void): () => void

  select(id: string): void
  /** Bring a run's profiler up, as `peak open` asks. */
  open(id: string): void
  setPaused(paused: boolean): void
  capture(command: string, cwd: string): Promise<void>
  attach(pid: number): Promise<void>
  listAttachable(): Promise<Attachable[]>
  takeSnapshot(id: string): Promise<HeapSnapshot | null>
  /** Record the runtime's call stacks for `ms`. Rejects when no agent can do it. */
  cpuProfile(id: string, ms: number): Promise<CpuProfile>
  forceGc(id: string): void
  kill(id: string): void
  restart(id: string): void
  remove(id: string): void
  clearEnded(): void

  // ─── stored history ───
  /** Runs newest first, optionally filtered by a substring of the command. */
  listRuns(query?: string): Promise<RunSummary[]>
  /** Bring a stored run back into the session and select it. */
  openRun(id: string): Promise<void>
  /** Fetch a run without adding it to the session (for comparison). */
  loadRun(id: string): Promise<Proc>
  deleteRun(id: string): Promise<boolean>
  /** Delete stopped runs older than `olderThanDays` (all stopped runs if omitted). Returns how many. */
  pruneRuns(olderThanDays?: number): Promise<number>

  // ─── settings and storage ───
  storageInfo(): Promise<StorageInfo>
  vacuum(): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(settings: Settings): Promise<Settings>

  // ─── targets ───
  addTarget(spec: TargetSpec): Promise<TargetState>
  removeTarget(id: string): Promise<void>
  /** Connecting happens in the background; watch `state.targets`. */
  connectTarget(id: string): Promise<void>
  disconnectTarget(id: string): Promise<void>
  listTargetProcesses(id: string): Promise<Attachable[]>
  attachTarget(id: string, pid: number): Promise<void>
  launchTarget(id: string, spec: LaunchSpec): Promise<void>
  /** Stop watching a remote run. Never signals it. */
  detach(id: string): Promise<void>
  /** One deliberate signal to a verified remote process. */
  signal(id: string, signal: string): Promise<void>

  // ─── discovery, without a collector ───
  dockerContexts(): Promise<string[]>
  dockerContainers(context: string): Promise<DockerContainer[]>
  dockerTotals(context: string, id: string): Promise<ContainerTotals | null>
  dockerTop(context: string, id: string): Promise<ContainerProcess[]>
  dockerLogs(context: string, id: string, tail: number): Promise<string>
  kubeContexts(): Promise<string[]>
  kubeNamespaces(context: string): Promise<string[]>
  kubePods(context: string, namespace: string): Promise<KubePod[]>
  kubeLogs(context: string, namespace: string, pod: string, container: string, tail: number): Promise<string>
  /** Null when the cluster has no metrics API, which is not an error. */
  kubeMetrics(context: string, namespace: string, pod: string): Promise<KubeMetrics[] | null>
  kubeAccess(context: string, namespace: string): Promise<KubeAccess>
}
