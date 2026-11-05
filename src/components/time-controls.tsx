import { AnimatePresence, motion } from "motion/react"
import { XIcon, ZoomInIcon } from "lucide-react"
import { Segmented } from "@/components/segmented"
import { RANGES, type AxisMode, type RangeKey, type View } from "@/lib/series"
import { formatClock, formatDuration } from "@/lib/format"
import { StatusDot } from "@/components/status"

export function TimeControls({
  view,
  setView,
  axis,
  setAxis,
  lastRange,
  live,
}: {
  view: View
  setView: (v: View) => void
  axis: AxisMode
  setAxis: (a: AxisMode) => void
  lastRange: RangeKey
  live: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <AnimatePresence mode="wait" initial={false}>
        {view.kind === "fixed" ? (
          <motion.button
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.18 }}
            onClick={() => setView({ kind: "live", range: lastRange })}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-foreground pr-2.5 pl-3.5 text-xs font-semibold text-background tabular-nums"
          >
            <ZoomInIcon className="size-3.5" />
            {formatClock(view.from)} – {formatClock(view.to)}
            <span className="opacity-60">· {formatDuration(view.to - view.from)}</span>
            <XIcon className="size-3.5 opacity-70" />
          </motion.button>
        ) : (
          <motion.span
            key="live"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"
          >
            <StatusDot status={live ? "running" : "exited"} />
            {live ? "Live" : "Ended"} · {view.range === "all" ? "entire run" : `last ${view.range}`}
            <span className="font-normal text-faint">— drag across a chart to zoom</span>
          </motion.span>
        )}
      </AnimatePresence>
      <div className="flex items-center gap-2">
      <Segmented<RangeKey | "">
        value={view.kind === "live" ? view.range : ""}
        onChange={(range) => range && setView({ kind: "live", range })}
        options={RANGES}
      />
      <Segmented<AxisMode>
        value={axis}
        onChange={setAxis}
        options={[
          { value: "elapsed", label: "T+" },
          { value: "clock", label: "Clock" },
        ]}
      />
      </div>
    </div>
  )
}
