import { DEFAULT_SETTINGS, type Alert, type Proc, type Settings } from "@/lib/types"
import { formatBytes, formatPercent } from "@/lib/format"

const MiB = 1024 * 1024
/** Memory has to fall this far below the limit before it can alert again. */
const REARM_RATIO = 0.9
/** Longer than this without samples, CPU can't be said to have stayed high. */
const MAX_GAP_MS = 5000

interface RunState {
  lastT: number
  /** Memory is below the limit (or has been), so a crossing would be new. */
  memoryArmed: boolean
  /** When the current unbroken stretch above the CPU limit began. */
  cpuSince: number | null
  cpuFired: boolean
}

/**
 * Turns threshold settings and incoming samples into alerts. One alert per
 * crossing: memory re-arms after dropping 10% below its limit, CPU after any
 * sample under its limit.
 */
export class AlertEngine {
  private settings: Settings = DEFAULT_SETTINGS
  private runs = new Map<string, RunState>()

  /** New thresholds apply from now on; the next samples are judged against them. */
  configure(settings: Settings) {
    this.settings = settings
    this.runs.clear()
  }

  get notifications() {
    return this.settings.notifications
  }

  /** New alerts for a process, given its latest samples. */
  check(proc: Proc): Alert[] {
    const s = this.settings
    if (!s.alertsEnabled || proc.status !== "running") {
      this.runs.delete(proc.id)
      return []
    }
    const memoryLimit = s.alertMemoryMib * MiB
    const cpuActive = s.alertCpuPercent > 0 && s.alertCpuSeconds > 0
    const known = this.runs.get(proc.id)
    const state = known ?? {
      // First sight of a run: judge its latest sample only, no backfill. Alerts it
      // already carries (reloaded window, same limit) aren't announced again.
      lastT: (proc.samples.at(-2) ?? { t: -Infinity }).t,
      memoryArmed: !proc.alerts?.some((a) => a.kind === "memory" && a.threshold === memoryLimit),
      cpuSince: null,
      cpuFired: !!proc.alerts?.some((a) => a.kind === "cpu" && a.threshold === s.alertCpuPercent),
    }
    this.runs.set(proc.id, state)

    let start = proc.samples.length
    while (start > 0 && proc.samples[start - 1].t > state.lastT) start--

    const fresh: Alert[] = []
    for (const sample of proc.samples.slice(start)) {
      if (memoryLimit > 0) {
        if (state.memoryArmed && sample.rss >= memoryLimit) {
          state.memoryArmed = false
          fresh.push({
            t: sample.t,
            kind: "memory",
            message: `Memory reached ${formatBytes(sample.rss)} (limit ${formatBytes(memoryLimit)})`,
            value: sample.rss,
            threshold: memoryLimit,
          })
        } else if (sample.rss < memoryLimit * REARM_RATIO) {
          state.memoryArmed = true
        }
      }
      if (cpuActive) {
        if (sample.cpu < s.alertCpuPercent) {
          state.cpuSince = null
          state.cpuFired = false
        } else {
          if (sample.t - state.lastT > MAX_GAP_MS) state.cpuSince = null
          state.cpuSince ??= sample.t
          if (!state.cpuFired && sample.t - state.cpuSince >= s.alertCpuSeconds * 1000) {
            state.cpuFired = true
            fresh.push({
              t: sample.t,
              kind: "cpu",
              message: `CPU above ${formatPercent(s.alertCpuPercent)} for ${s.alertCpuSeconds}s (now ${formatPercent(sample.cpu)})`,
              value: sample.cpu,
              threshold: s.alertCpuPercent,
            })
          }
        }
      }
      state.lastT = sample.t
    }
    return fresh
  }
}

/** Run the engine over updated processes: attach new alerts and report them. */
export function applyAlerts<P extends Proc>(engine: AlertEngine, procs: P[], onAlert: (proc: P, alert: Alert) => void): P[] {
  return procs.map((p) => {
    const fresh = engine.check(p)
    if (!fresh.length) return p
    const next = { ...p, alerts: [...(p.alerts ?? []), ...fresh] }
    fresh.forEach((a) => onAlert(next, a))
    return next
  })
}
