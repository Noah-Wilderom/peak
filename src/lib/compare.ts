import { TICK_MS, type Proc } from "@/lib/types"
import { average } from "@/lib/series"
import { formatBytes, formatDuration } from "@/lib/format"

export interface RunStats {
  peakRss: number
  /** Null while the run is still going: its length isn't known yet. */
  durationMs: number | null
  avgCpu: number
  /** False when no real measurement was stored for this run. */
  hasData: boolean
  /** Elapsed time before the first stored sample (attached late, or history trimmed). */
  firstSampleAt: number
}

export function runStats(p: Proc): RunStats {
  const first = p.samples[0]
  const hasData = p.samples.length > 1 || first.rss > 0
  return {
    peakRss: p.peak.rss,
    durationMs: p.endedAt != null ? p.endedAt - p.startedAt : null,
    avgCpu: average(p.samples, "cpu"),
    hasData,
    firstSampleAt: Math.max(0, first.t - p.startedAt),
  }
}

export interface AlignedPoint {
  /** Milliseconds since the run's own start. */
  offset: number
  a?: number
  b?: number
}

/**
 * Both memory curves on a shared elapsed-time axis, bucketed with per-bucket
 * maxima so spikes survive. A run that ended earlier simply has no value after
 * its end: its line stops instead of dropping to zero.
 */
export function alignRuns(a: Proc, b: Proc, points = 300): AlignedPoint[] {
  const span = (p: Proc) => p.samples.at(-1)!.t - p.startedAt
  const bucket = Math.max(TICK_MS, Math.ceil(Math.max(span(a), span(b)) / points / TICK_MS) * TICK_MS)
  const rows = new Map<number, AlignedPoint>()
  const add = (p: Proc, key: "a" | "b") => {
    for (const s of p.samples) {
      const offset = Math.floor(Math.max(0, s.t - p.startedAt) / bucket) * bucket
      const row = rows.get(offset) ?? { offset }
      row[key] = Math.max(row[key] ?? 0, s.rss)
      rows.set(offset, row)
    }
  }
  add(a, "a")
  add(b, "b")
  return [...rows.values()].sort((x, y) => x.offset - y.offset)
}

const sign = (v: number) => (v >= 0 ? "+" : "−")

/** "+12 MiB (+10%)" — the change from run A to run B. */
export function bytesDelta(a: number, b: number) {
  const d = b - a
  const pct = a > 0 ? ` (${sign(d)}${Math.abs((d / a) * 100).toFixed(1)}%)` : ""
  return `${sign(d)}${formatBytes(Math.abs(d))}${pct}`
}

/** Change in run length, or a dash when either run hasn't finished. */
export function durationDelta(a: number | null, b: number | null) {
  if (a === null || b === null) return "—"
  return `${sign(b - a)}${formatDuration(Math.abs(b - a))}`
}

/** Percentage points, because CPU % is itself a unit (100% = one core). */
export function cpuDelta(a: number, b: number) {
  return `${sign(b - a)}${Math.abs(b - a).toFixed(1)} pts`
}
