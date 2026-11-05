import { useMemo } from "react"
import { motion } from "motion/react"
import { TrendingDownIcon, TrendingUpIcon, WavesIcon, MinusIcon } from "lucide-react"
import {
  AllocChart,
  CompositionChart,
  DistributionChart,
  FaultsChart,
  GcChart,
  compositionConfig,
} from "@/components/charts/memory-detail-charts"
import { useTimeline } from "@/components/charts/timeline"
import { Card } from "@/components/card"
import { Tween } from "@/components/tween"
import { Bytes } from "@/components/bytes"
import type { Proc, Sample } from "@/lib/types"
import { analyzeTrend, composition, COMPOSITION_KEYS, gcStats } from "@/lib/analysis"
import { formatBytes, formatDuration, formatMs } from "@/lib/format"
import { percentiles, visibleSamples, type View } from "@/lib/series"

const VERDICT = {
  growing: { icon: TrendingUpIcon, title: "Growing steadily.", body: "Memory climbs in a straight line — the shape of a leak." },
  shrinking: { icon: TrendingDownIcon, title: "Shrinking.", body: "Memory is being released over the window." },
  oscillating: { icon: WavesIcon, title: "Oscillating.", body: "Allocations are being reclaimed in cycles." },
  stable: { icon: MinusIcon, title: "Stable.", body: "No meaningful growth over the window." },
}

export function MemoryTab({ totalMemory }: { totalMemory: number }) {
  const { proc, view } = useTimeline()
  const { samples, from, to } = useMemo(() => windowOf(proc, view), [proc, view])
  const t = useMemo(() => analyzeTrend(samples, totalMemory), [samples, totalMemory])
  const [p50, p95, p99] = useMemo(() => percentiles(samples.map((s) => s.rss), [50, 95, 99]), [samples])
  const gc = useMemo(() => gcStats(proc, from, to), [proc, from, to])
  const last = proc.samples.at(-1)!
  const V = VERDICT[t.verdict]

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={t.verdict === "growing" ? "rounded-card bg-warning/10 p-5 ring-1 ring-warning/25 ring-inset" : "rounded-card bg-secondary p-5"}>
          <div className={`flex items-center gap-2 text-xs font-semibold ${t.verdict === "growing" ? "text-warning" : "text-muted-foreground"}`}>
            <V.icon className="size-4" /> Trend over window
          </div>
          <p className="mt-3 text-title">{V.title}</p>
          <p className="mt-1 text-sm opacity-70">{V.body}</p>
          <div className="mt-4 flex gap-6 text-sm tabular-nums">
            <span>
              <Tween value={t.perMin} format={(v) => `${v >= 0 ? "+" : "−"}${formatBytes(Math.abs(v))}/min`} className="font-semibold" />
            </span>
            <span className="opacity-70">R² {t.r2.toFixed(2)}</span>
          </div>
          {Number.isFinite(t.toLimit) && (
            <p className="mt-2 text-xs opacity-70">Reaches system memory ({formatBytes(totalMemory)}) in ~{formatDuration(t.toLimit)}.</p>
          )}
        </div>

        <div className="rounded-card border border-border p-5">
          <p className="text-xs font-semibold text-muted-foreground">Resident memory percentiles</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">
            <Stat label="p50" value={p50} format={formatBytes} bytes />
            <Stat label="p95" value={p95} format={formatBytes} bytes />
            <Stat label="p99" value={p99} format={formatBytes} bytes />
            <Stat label="max (all time)" value={proc.peak.rss} format={formatBytes} accent bytes />
          </dl>
        </div>

        <div className="rounded-card border border-border p-5">
          <p className="text-xs font-semibold text-muted-foreground">Garbage collection</p>
          {proc.hasGc ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">
              <Stat label={`collections (${gc.major} major)`} value={gc.count} format={(v) => Math.round(v).toLocaleString()} />
              <Stat label="time paused" value={gc.overhead * 100} format={(v) => `${v.toFixed(2)}%`} />
              <Stat label="p99 pause" value={gc.p99} format={formatMs} />
              <Stat label="reclaimed" value={gc.freed} format={formatBytes} bytes />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {proc.runtime === "rust" ? "Rust frees memory deterministically — there is no collector to observe." : "No collector data for this runtime."}
            </p>
          )}
        </div>
      </div>

      <Card title="Composition." subtitle="Where resident memory lives, stacked. Drag across any chart to zoom.">
        <CompositionChart />
        <BreakdownBar sample={last} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Allocation rate." subtitle="Bytes allocated per second — churn the collector has to clean up.">
          <AllocChart />
        </Card>
        <Card title="Page faults." subtitle="Minor faults per second; spikes mean fresh pages being touched.">
          <FaultsChart />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="GC pauses." subtitle="Each collection, by how long it stopped the world.">
          {proc.hasGc ? <GcChart /> : <Empty>No garbage collector.</Empty>}
        </Card>
        <Card title="Distribution." subtitle="How much of the window was spent at each memory level.">
          <DistributionChart samples={samples} />
        </Card>
      </div>
    </motion.div>
  )
}

function windowOf(proc: Proc, view: View) {
  const samples = visibleSamples(proc, view)
  return { samples, from: samples[0]?.t ?? 0, to: samples.at(-1)?.t ?? 0 }
}

function Stat({
  label,
  value,
  format,
  accent,
  bytes,
}: {
  label: string
  value: number
  format: (v: number) => string
  accent?: boolean
  bytes?: boolean
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {accent && <span className="size-1.5 rounded-full bg-signal" />}
        {label}
      </dt>
      <dd className="mt-0.5 text-[17px] font-semibold tabular-nums">
        {bytes ? <Bytes value={value} /> : <Tween value={value} format={format} />}
      </dd>
    </div>
  )
}

function BreakdownBar({ sample }: { sample: Sample }) {
  const parts = composition(sample)
  const total = Object.values(parts).reduce((a, b) => a + b, 0) || 1
  const keys = COMPOSITION_KEYS
  return (
    <div className="mt-5 border-t border-border pt-5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">Right now</span>
        <span className="text-muted-foreground tabular-nums">{formatBytes(sample.rss)} resident</span>
      </div>
      <div className="mt-3 flex h-3 gap-[2px] overflow-hidden rounded-full">
        {keys.map((k) => (
          <motion.div
            key={k}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ background: compositionConfig[k].color }}
            animate={{ width: `${(parts[k] / total) * 100}%` }}
            transition={{ duration: 0.8, ease: [0.25, 1, 0.5, 1] }}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-5 gap-3">
        {keys.map((k) => (
          <div key={k} className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: compositionConfig[k].color }} />
              <span className="truncate">{compositionConfig[k].label}</span>
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums">
              <Tween value={parts[k]} format={formatBytes} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[200px] items-center justify-center rounded-2xl bg-secondary text-sm text-muted-foreground">{children}</div>
}
