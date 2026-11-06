import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { MouseHandlerDataParam } from "recharts"
import { TICK_MS, type MetricKey, type Proc, type Sample } from "@/lib/types"
import { byteUnit, niceTicks, timeStep, timeTicks, viewData, type AxisMode, type View } from "@/lib/series"
import { nearestMarker, timelineMarkers } from "@/lib/markers"
import { formatClock, formatOffset } from "@/lib/format"
import { useTimeDomain, useTweened } from "@/hooks/use-smooth"

interface TimelineValue {
  proc: Proc
  view: View
  setView: (v: View) => void
  axis: AxisMode
  paused: boolean
  /** Open the run's output at this time. */
  onJump: (t: number) => void
  data: Sample[]
  bucketMs: number
  /** The range every chart holds while a drag is under way. */
  held: Held | null
  setHeld: (held: Held | null) => void
}

/** What was on screen when the pointer went down. */
interface Held {
  from: number
  to: number
  proc: Proc
}

type TimelineProps = Pick<TimelineValue, "proc" | "view" | "setView" | "axis" | "paused" | "onJump">

/** A press and release this close together is a click, not a drag. */
const CLICK_SLOP_PX = 4

/** Windows this short show tenths of a second in tooltips, where samples would otherwise share a label. */
const TENTHS_SPAN_MS = 10_000

/**
 * The shortest drag that zooms. Pointer positions snap to samples, so two samples
 * are the least a drag can select, and short windows need that to be reachable.
 * Half an interval allows for samples arriving slightly under one interval apart.
 */
function minZoomMs(span: number) {
  return Math.min(TICK_MS * 4, Math.max(TICK_MS / 2, span / 10))
}

const TimelineContext = createContext<TimelineValue | null>(null)

export function TimelineProvider({
  proc,
  view,
  setView,
  axis,
  paused,
  onJump,
  children,
}: TimelineProps & { children: React.ReactNode }) {
  // A live 1s window crosses the whole plot every second, so nothing could be
  // dragged across unless the data stands still until the pointer is released.
  const [held, setHeld] = useState<Held | null>(null)
  const shown = held?.proc ?? proc
  const { data, bucketMs } = useMemo(() => viewData(shown, view), [shown, view])
  return (
    <TimelineContext.Provider value={{ proc, view, setView, axis, paused, onJump, data, bucketMs, held, setHeld }}>
      {children}
    </TimelineContext.Provider>
  )
}

export function useTimeline() {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error("useTimeline must be used inside <TimelineProvider>")
  return ctx
}

export function formatTimeLabel(t: number, proc: Proc, tenths = false) {
  return `T+${formatOffset(t - proc.startedAt, tenths)}  ·  ${formatClock(t, tenths)}`
}

/**
 * Everything a time-series chart needs: the gliding x-domain, aligned ticks,
 * synced crosshair and drag-to-zoom handlers.
 */
export function useTimelineChart() {
  const ctx = useTimeline()
  const { proc, view, setView, axis, paused, onJump, held, setHeld } = ctx
  const glide = useTimeDomain(proc, view, paused)
  const [from, to] = held ? [held.from, held.to] : glide
  const [sel, setSel] = useState<{ a: number; b: number; x: number } | null>(null)
  const pressed = useRef(false)
  // A chart can go away mid-drag, and nothing else would release the others.
  useEffect(() => () => setHeld(null), [setHeld])

  // A process younger than the range has nothing to label before it started.
  const ticks = timeTicks(from, to, axis, proc.startedAt).filter((t) => t >= proc.startedAt)
  const span = to - from
  const tenths = timeStep(span) < 1000
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
    tickFormatter: (t: number) => (axis === "elapsed" ? formatOffset(t - proc.startedAt, tenths) : formatClock(t, tenths)),
  }

  const release = () => {
    pressed.current = false
    setSel(null)
    setHeld(null)
  }
  const label = (l: MouseHandlerDataParam) => (typeof l?.activeLabel === "number" ? l.activeLabel : Number(l?.activeLabel))
  const chart = {
    syncId: `timeline-${proc.id}`,
    syncMethod: "value" as const,
    onMouseDown: (s: MouseHandlerDataParam, e: React.MouseEvent) => {
      const x = label(s)
      pressed.current = true
      setHeld({ from, to, proc })
      if (Number.isFinite(x)) setSel({ a: x, b: x, x: e.clientX })
    },
    onMouseMove: (s: MouseHandlerDataParam, e: React.MouseEvent) => {
      // There's no reading while the nearest sample is past the plot's edge, which a
      // short window hits often. Then the drag has reached the edge on that side, or
      // if it's only starting, it starts with the first reading.
      const x = label(s)
      if (sel) setSel({ ...sel, b: Number.isFinite(x) ? x : e.clientX > sel.x ? to : from })
      else if (pressed.current && Number.isFinite(x)) setSel({ a: x, b: x, x: e.clientX })
    },
    onMouseUp: (_: MouseHandlerDataParam, e: React.MouseEvent) => {
      // Pointer positions snap to samples, which can sit just past the plot's edges.
      const zoomFrom = sel && Math.max(from, Math.min(sel.a, sel.b))
      const zoomTo = sel && Math.min(to, Math.max(sel.a, sel.b))
      if (sel && zoomTo! - zoomFrom! >= minZoomMs(span)) {
        setView({ kind: "fixed", from: zoomFrom!, to: zoomTo! })
      } else if (sel && Math.abs(e.clientX - sel.x) <= CLICK_SLOP_PX) {
        // Too short to be a zoom, and the pointer stayed put: a click. A drag across
        // too little data is neither. Snap to an event if it was aimed at one.
        const hit = nearestMarker(timelineMarkers(proc, from, to), sel.a, Math.max(span * 0.015, TICK_MS / 2))
        onJump(hit?.t ?? sel.a)
      }
      release()
    },
    onMouseLeave: release,
    style: { cursor: "crosshair" },
  }

  return {
    ...ctx,
    from,
    to,
    xAxis,
    chart,
    selection: sel,
    timeLabel: (t: number) => formatTimeLabel(t, proc, span <= TENTHS_SPAN_MS),
    /** A lone sample has no line to draw, so it needs a visible point. */
    dot: ctx.data.length === 1,
  }
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

/**
 * Max of `keys` (summed if `stack`) over the samples within [from, to] and the one
 * just outside each edge, since the visible line runs towards those. In a short
 * window they can be all there is to draw.
 */
export function visibleMax(data: Sample[], from: number, to: number, keys: (MetricKey)[], stack = false) {
  const inside = data.findIndex((d) => d.t >= from)
  const first = inside < 0 ? data.length - 1 : Math.max(0, inside - 1)
  const after = data.findIndex((d) => d.t > to)
  let m = 0
  for (const d of data.slice(first, after < 0 ? undefined : after + 1)) {
    const v = stack ? keys.reduce((s, k) => s + d[k], 0) : Math.max(...keys.map((k) => d[k]))
    if (v > m) m = v
  }
  return m
}
