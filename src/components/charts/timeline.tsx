import { createContext, useContext, useMemo, useState } from "react"
import type { MouseHandlerDataParam } from "recharts"
import { TICK_MS, type MetricKey, type Proc, type Sample } from "@/lib/types"
import { byteUnit, niceTicks, timeTicks, viewData, type AxisMode, type View } from "@/lib/series"
import { formatClock, formatOffset } from "@/lib/format"
import { useTimeDomain, useTweened } from "@/hooks/use-smooth"

interface TimelineValue {
  proc: Proc
  view: View
  setView: (v: View) => void
  axis: AxisMode
  paused: boolean
  data: Sample[]
  bucketMs: number
}

const TimelineContext = createContext<TimelineValue | null>(null)

export function TimelineProvider({
  proc,
  view,
  setView,
  axis,
  paused,
  children,
}: Omit<TimelineValue, "data" | "bucketMs"> & { children: React.ReactNode }) {
  const { data, bucketMs } = useMemo(() => viewData(proc, view), [proc, view])
  return (
    <TimelineContext.Provider value={{ proc, view, setView, axis, paused, data, bucketMs }}>
      {children}
    </TimelineContext.Provider>
  )
}

export function useTimeline() {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error("useTimeline must be used inside <TimelineProvider>")
  return ctx
}

export function formatTimeLabel(t: number, proc: Proc) {
  return `T+${formatOffset(t - proc.startedAt)}  ·  ${formatClock(t)}`
}

/**
 * Everything a time-series chart needs: the gliding x-domain, aligned ticks,
 * synced crosshair and drag-to-zoom handlers.
 */
export function useTimelineChart() {
  const ctx = useTimeline()
  const { proc, view, setView, axis, paused } = ctx
  const [from, to] = useTimeDomain(proc, view, paused)
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)

  // A process younger than the range has nothing to label before it started.
  const ticks = timeTicks(from, to, axis, proc.startedAt).filter((t) => t >= proc.startedAt)
  const xAxis = {
    dataKey: "t",
    type: "number" as const,
    domain: [from, to],
    allowDataOverflow: true,
    ticks,
    interval: 0 as const,
    tickLine: false,
    axisLine: false,
    tickMargin: 10,
    tickFormatter: (t: number) => (axis === "elapsed" ? formatOffset(t - proc.startedAt) : formatClock(t)),
  }

  const label = (l: MouseHandlerDataParam) => (typeof l?.activeLabel === "number" ? l.activeLabel : Number(l?.activeLabel))
  const chart = {
    syncId: `timeline-${proc.id}`,
    syncMethod: "value" as const,
    onMouseDown: (s: MouseHandlerDataParam) => {
      const x = label(s)
      if (Number.isFinite(x)) setSel({ a: x, b: x })
    },
    onMouseMove: (s: MouseHandlerDataParam) => {
      const x = label(s)
      if (sel && Number.isFinite(x)) setSel({ ...sel, b: x })
    },
    onMouseUp: () => {
      if (sel && Math.abs(sel.b - sel.a) >= TICK_MS * 4) {
        setView({ kind: "fixed", from: Math.min(sel.a, sel.b), to: Math.max(sel.a, sel.b) })
      }
      setSel(null)
    },
    onMouseLeave: () => setSel(null),
    style: { cursor: "crosshair" },
  }

  return { ...ctx, from, to, xAxis, chart, selection: sel }
}

/** Y axis that eases between nice maxima instead of snapping. */
export function useEasedYAxis(max: number, opts: { bytes?: boolean; count?: number; min?: number } = {}) {
  const target = Math.max(max, opts.min ?? 0) * 1.08
  const ticksAll = niceTicks(target, opts.count ?? 4, opts.bytes ? byteUnit(target) : 1)
  const top = useTweened(ticksAll.at(-1)!)
  return {
    domain: [0, top] as [number, number],
    ticks: ticksAll.filter((t) => t <= top * 1.001),
    allowDataOverflow: true,
  }
}

/** Max of `keys` (summed if `stack`) over the samples within [from, to]. */
export function visibleMax(data: Sample[], from: number, to: number, keys: (MetricKey)[], stack = false) {
  let m = 0
  for (const d of data) {
    if (d.t < from || d.t > to) continue
    const v = stack ? keys.reduce((s, k) => s + d[k], 0) : Math.max(...keys.map((k) => d[k]))
    if (v > m) m = v
  }
  return m
}
