import { TICK_MS, type MetricKey, type Proc, type Sample } from "@/lib/types"

export type RangeKey = "30s" | "1m" | "5m" | "15m" | "1h" | "all"

export const RANGES: { value: RangeKey; label: string; ms: number }[] = [
  { value: "30s", label: "30s", ms: 30_000 },
  { value: "1m", label: "1m", ms: 60_000 },
  { value: "5m", label: "5m", ms: 300_000 },
  { value: "15m", label: "15m", ms: 900_000 },
  { value: "1h", label: "1h", ms: 3_600_000 },
  { value: "all", label: "All", ms: Infinity },
]

/** What slice of time the charts show. */
export type View =
  | { kind: "live"; range: RangeKey }
  | { kind: "fixed"; from: number; to: number }

export type AxisMode = "elapsed" | "clock"

/** Points per chart; buckets are aligned to absolute time so they never shift. */
const TARGET_POINTS = 240

export function rangeMs(proc: Proc, view: View) {
  if (view.kind === "fixed") return view.to - view.from
  const ms = RANGES.find((r) => r.value === view.range)!.ms
  const span = proc.samples.at(-1)!.t - proc.samples[0].t
  return ms === Infinity ? Math.max(span, 30_000) : ms
}

export function bucketMsFor(span: number) {
  return Math.max(TICK_MS, Math.ceil(span / TARGET_POINTS / TICK_MS) * TICK_MS)
}

/**
 * Samples covering the view, bucketed by absolute time with per-field max so a
 * memory spike is never smoothed away. Includes one bucket of overflow on each
 * side so lines run cleanly off the clipped plot edges while scrolling.
 */
export function viewData(proc: Proc, view: View) {
  const span = rangeMs(proc, view)
  const bucketMs = bucketMsFor(span)
  const last = proc.samples.at(-1)!.t
  const from = (view.kind === "fixed" ? view.from : last - span) - 2 * bucketMs
  const to = view.kind === "fixed" ? view.to + 2 * bucketMs : Infinity

  const samples = proc.samples
  let i = lowerBound(samples, from)
  const out: Sample[] = []
  let cur: Sample | null = null
  let curKey = -1
  for (; i < samples.length && samples[i].t <= to; i++) {
    const x = samples[i]
    const key = Math.floor(x.t / bucketMs)
    if (key !== curKey) {
      if (cur) out.push(cur)
      cur = { ...x }
      curKey = key
      continue
    }
    const c = cur!
    c.t = x.t
    if (x.rss > c.rss) {
      // Keep composition consistent with the max-RSS sample in the bucket.
      c.rss = x.rss
      c.heap = x.heap
      c.heapTotal = x.heapTotal
      c.external = x.external
      c.code = x.code
      c.stack = x.stack
    }
    if (x.cpu > c.cpu) {
      c.cpu = x.cpu
      c.cpuUser = x.cpuUser
      c.cpuSys = x.cpuSys
    }
    c.read = Math.max(c.read, x.read)
    c.write = Math.max(c.write, x.write)
    c.alloc = Math.max(c.alloc, x.alloc)
    c.faults = Math.max(c.faults, x.faults)
  }
  if (cur) out.push(cur)
  return { data: out, bucketMs, span }
}

/** Raw (un-bucketed) samples strictly inside the visible window — for stats. */
export function visibleSamples(proc: Proc, view: View) {
  const last = proc.samples.at(-1)!.t
  const from = view.kind === "fixed" ? view.from : last - rangeMs(proc, view)
  const to = view.kind === "fixed" ? view.to : last
  const i = lowerBound(proc.samples, from)
  let j = i
  while (j < proc.samples.length && proc.samples[j].t <= to) j++
  return proc.samples.slice(i, j)
}

function lowerBound(samples: { t: number }[], t: number) {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ─── axis ticks ──────────────────────────────────────────────────────────────

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000)

/**
 * Ticks aligned to round multiples (of elapsed time or wall clock), so they
 * scroll with the data instead of re-spacing every frame.
 */
export function timeTicks(from: number, to: number, mode: AxisMode, origin: number, count = 6) {
  const span = to - from
  const step = TIME_STEPS.find((s) => span / s <= count) ?? TIME_STEPS.at(-1)!
  const base = mode === "elapsed" ? origin : 0
  const first = Math.ceil((from - base) / step) * step + base
  const ticks: number[] = []
  for (let t = first; t <= to; t += step) ticks.push(t)
  return ticks
}

/** Round axis ticks: 0, step, 2·step… with step ∈ {1, 2, 2.5, 5}·10ⁿ of `unit`. */
export function niceTicks(max: number, count = 4, unit = 1) {
  const raw = Math.max(max / unit, 1e-9) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  // raw < 10·mag by construction, so a step always matches.
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw)! * mag * unit
  const ticks: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v)
  return ticks
}

/** 1024-based unit that keeps byte ticks readable (KB, MB or GB). */
export function byteUnit(max: number) {
  const k = 1024
  if (max >= k ** 3) return k ** 3
  if (max >= k ** 2) return k ** 2
  return k
}

// ─── statistics ──────────────────────────────────────────────────────────────

export function average(samples: Sample[], key: MetricKey) {
  if (!samples.length) return 0
  let sum = 0
  for (const s of samples) sum += s[key]
  return sum / samples.length
}

export function maxOf(samples: Sample[], key: MetricKey) {
  let m = 0
  for (const s of samples) if (s[key] > m) m = s[key]
  return m
}

/** Value of `key` roughly `ms` before the latest sample. */
export function valueAgo(samples: Sample[], key: MetricKey, ms: number) {
  const last = samples.at(-1)
  if (!last) return 0
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t >= ms) return samples[i][key]
  }
  return samples[0][key]
}

export function percentiles(values: number[], ps: number[]) {
  if (!values.length) return ps.map(() => 0)
  const sorted = [...values].sort((a, b) => a - b)
  return ps.map((p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))])
}

export function stddev(values: number[]) {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1))
}

/** Least-squares slope of `key` in units per millisecond, plus R². */
export function trend(samples: Sample[], key: MetricKey) {
  const n = samples.length
  if (n < 10) return { slope: 0, r2: 0 }
  const t0 = samples[0].t
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0
  for (const s of samples) {
    const x = s.t - t0
    const y = s[key]
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y
  }
  const den = n * sxx - sx * sx
  if (den === 0) return { slope: 0, r2: 0 }
  const slope = (n * sxy - sx * sy) / den
  const rNum = n * sxy - sx * sy
  const rDen = Math.sqrt(den * (n * syy - sy * sy))
  return { slope, r2: rDen === 0 ? 0 : (rNum / rDen) ** 2 }
}

/** Fixed-width histogram over [0, max]. */
export function histogram(values: number[], bins: number, max: number) {
  const width = max / bins
  const counts = Array.from({ length: bins }, (_, i) => ({ x0: i * width, x1: (i + 1) * width, count: 0 }))
  for (const v of values) counts[Math.min(bins - 1, Math.floor(v / width))].count++
  return counts
}
