import { SYSTEM_MEMORY, type HeapSnapshot, type Proc, type Sample } from "@/lib/types"
import { percentiles, stddev, trend } from "@/lib/series"

const MB = 1024 * 1024

// ─── memory composition ──────────────────────────────────────────────────────

export const COMPOSITION_KEYS = ["heapUsed", "heapFree", "external", "native", "codeStack"] as const
export type CompositionKey = (typeof COMPOSITION_KEYS)[number]

/** Split resident memory into stacked, non-overlapping parts. */
export function composition(s: Sample): Record<CompositionKey, number> {
  const codeStack = s.code + s.stack
  return {
    heapUsed: s.heap,
    heapFree: Math.max(0, s.heapTotal - s.heap),
    external: s.external,
    native: Math.max(0, s.rss - s.heapTotal - s.external - codeStack),
    codeStack,
  }
}

// ─── trend ───────────────────────────────────────────────────────────────────

export type Verdict = "growing" | "shrinking" | "oscillating" | "stable"

/** Classify the memory trend over a window of samples. */
export function analyzeTrend(samples: Sample[], systemMemory = SYSTEM_MEMORY) {
  const { slope, r2 } = trend(samples, "rss")
  const perMin = slope * 60_000
  const values = samples.map((s) => s.rss)
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
  const cv = mean ? stddev(values) / mean : 0
  let verdict: Verdict = "stable"
  if (perMin > 0.5 * MB && r2 > 0.6) verdict = "growing"
  else if (perMin < -0.5 * MB && r2 > 0.6) verdict = "shrinking"
  else if (cv > 0.08) verdict = "oscillating"
  const last = samples.at(-1)?.rss ?? 0
  const toLimit = verdict === "growing" ? Math.max(0, systemMemory - last) / slope : Infinity
  return { perMin, r2, verdict, cv, toLimit }
}

// ─── garbage collection ──────────────────────────────────────────────────────

export function gcStats(proc: Pick<Proc, "gc">, from: number, to: number) {
  const events = proc.gc.filter((g) => g.t >= from && g.t <= to)
  const pauses = events.map((g) => g.pauseMs)
  const total = pauses.reduce((a, b) => a + b, 0)
  const [p50, p99] = percentiles(pauses, [50, 99])
  return {
    count: events.length,
    major: events.filter((g) => g.kind === "major").length,
    total,
    p50,
    p99,
    max: Math.max(0, ...pauses),
    freed: events.reduce((a, g) => a + g.freed, 0),
    overhead: to > from ? total / (to - from) : 0,
  }
}

// ─── heap snapshots ──────────────────────────────────────────────────────────

export interface DiffRow {
  name: string
  count: number
  shallow: number
  retained: number
  delta: number
  deltaCount: number
  isNew: boolean
}

/** Per-type changes between two snapshots (base may be absent). */
export function diffSnapshots(current: HeapSnapshot, base?: HeapSnapshot): DiffRow[] {
  const prev = new Map(base?.entries.map((e) => [e.name, e]))
  return current.entries
    .map((e) => {
      const b = prev.get(e.name)
      return {
        ...e,
        delta: base ? e.retained - (b?.retained ?? 0) : 0,
        deltaCount: base ? e.count - (b?.count ?? 0) : 0,
        isNew: !!base && !b,
      }
    })
    .sort((a, b) => b.retained - a.retained)
}

/** The type most likely responsible for growth, if growth is significant. */
export function topGrower(rows: DiffRow[], heapUsed: number) {
  const top = [...rows].sort((a, b) => b.delta - a.delta)[0]
  if (!top || top.delta <= 0 || top.delta < heapUsed * 0.03) return null
  return top
}
