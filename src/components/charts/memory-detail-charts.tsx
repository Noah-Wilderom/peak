import { freedIsReported } from "@/lib/agents"
import { useMemo } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useEasedYAxis, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { formatBytes, formatCount, formatMs, formatRate } from "@/lib/format"
import { histogram, percentiles } from "@/lib/series"
import type { Sample } from "@/lib/types"
import { composition, COMPOSITION_KEYS, type CompositionKey } from "@/lib/analysis"

// ─── composition ─────────────────────────────────────────────────────────────

export const compositionConfig = {
  heapUsed: { label: "Heap used", color: "var(--comp-1)" },
  heapFree: { label: "Heap reserved", color: "var(--comp-2)" },
  external: { label: "External / buffers", color: "var(--comp-3)" },
  native: { label: "Native", color: "var(--comp-4)" },
  codeStack: { label: "Code + stacks", color: "var(--comp-5)" },
} satisfies Record<CompositionKey, { label: string; color: string }>

const KEYS = COMPOSITION_KEYS

export function CompositionChart() {
  const { data, from, to, xAxis, chart, selection, timeLabel, dot } = useTimelineChart()
  const rows = useMemo(() => data.map((d) => ({ t: d.t, ...composition(d) })), [data])
  const y = useEasedYAxis(visibleMax(data, from, to, ["rss"]), { bytes: true })

  return (
    <>
      {/* Manual legend: the areas are stroked in the surface colour for 2px gaps. */}
      <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 pb-3 text-xs">
        {KEYS.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: compositionConfig[k].color }} />
            {compositionConfig[k].label}
          </span>
        ))}
      </div>
    <ChartContainer config={compositionConfig} className="aspect-auto h-[260px] w-full">
      <AreaChart data={rows} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis {...xAxis} />
        <YAxis {...y} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatBytes(v)} />
        <ChartTooltip
          cursor={{ stroke: "var(--faint)", strokeWidth: 1 }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: item.color }} />
                  <span className="flex-1 text-muted-foreground">{compositionConfig[name as CompositionKey]?.label}</span>
                  <span className="pl-4 font-mono tabular-nums">{formatBytes(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        {KEYS.map((k) => (
          <Area
            key={k}
            dataKey={k}
            stackId="mem"
            type="monotone"
            stroke="var(--background)"
            strokeWidth={1.5}
            fill={`var(--color-${k})`}
            fillOpacity={1}
            isAnimationActive={false}
            dot={dot}
          />
        ))}
        {selection && <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--signal)" fillOpacity={0.08} />}
      </AreaChart>
    </ChartContainer>
    </>
  )
}

// ─── single-series rate charts ───────────────────────────────────────────────

function RateChart({
  dataKey,
  label,
  format,
  axisFormat,
  bytes,
}: {
  dataKey: "alloc" | "faults"
  label: string
  format: (v: number) => string
  axisFormat: (v: number) => string
  bytes?: boolean
}) {
  const { data, from, to, xAxis, chart, selection, timeLabel, dot } = useTimelineChart()
  const y = useEasedYAxis(visibleMax(data, from, to, [dataKey]), { bytes, count: 3, min: 1 })
  const config = { [dataKey]: { label, color: "var(--chart-1)" } } satisfies ChartConfig

  return (
    <ChartContainer config={config} className="aspect-auto h-[170px] w-full">
      <AreaChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis {...xAxis} />
        <YAxis {...y} tickLine={false} axisLine={false} width={64} tickFormatter={axisFormat} />
        <ChartTooltip
          cursor={{ stroke: "var(--faint)", strokeWidth: 1 }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
              formatter={(value) => (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono tabular-nums">{format(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          stroke={`var(--color-${dataKey})`}
          strokeWidth={2}
          fill={`var(--color-${dataKey})`}
          fillOpacity={0.08}
          isAnimationActive={false}
          dot={dot}
        />
        {selection && <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--foreground)" fillOpacity={0.06} />}
      </AreaChart>
    </ChartContainer>
  )
}

export function AllocChart() {
  return <RateChart dataKey="alloc" label="Allocated" bytes format={formatRate} axisFormat={(v) => formatBytes(v)} />
}

export function FaultsChart() {
  return <RateChart dataKey="faults" label="Minor faults/s" format={(v) => `${formatCount(v)}/s`} axisFormat={formatCount} />
}

// ─── GC pauses ───────────────────────────────────────────────────────────────

const gcConfig = {
  minor: { label: "Minor (scavenge)", color: "var(--chart-2)" },
  major: { label: "Major (mark-compact)", color: "var(--warning)" },
} satisfies ChartConfig

export function GcChart() {
  const { proc, from, to, xAxis, timeLabel } = useTimelineChart()
  const visible = useMemo(() => proc.gc.filter((g) => g.t >= from - 5000 && g.t <= to), [proc.gc, from, to])
  const minor = visible.filter((g) => g.kind === "minor")
  const major = visible.filter((g) => g.kind === "major")
  const y = useEasedYAxis(Math.max(5, ...visible.map((g) => g.pauseMs)), { count: 3 })

  return (
    <ChartContainer config={gcConfig} className="aspect-auto h-[200px] w-full">
      <ScatterChart margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis {...xAxis} />
        <YAxis dataKey="pauseMs" {...y} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}ms`} />
        <ZAxis range={[24, 24]} />
        <ChartTooltip
          isAnimationActive={false}
          cursor={false}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
              formatter={(_, __, item) => {
                const g = item.payload as (typeof visible)[number]
                return (
                  <div className="grid w-full gap-1">
                    <span className="font-semibold">{gcConfig[g.kind].label}</span>
                    <span className="flex justify-between gap-6">
                      <span className="text-muted-foreground">Pause</span>
                      <span className="font-mono tabular-nums">{formatMs(g.pauseMs)}</span>
                    </span>
                    {freedIsReported(proc) && (
                      <span className="flex justify-between gap-6">
                        <span className="text-muted-foreground">Freed</span>
                        <span className="font-mono tabular-nums">{formatBytes(g.freed)}</span>
                      </span>
                    )}
                  </div>
                )
              }}
            />
          }
        />
        <ChartLegend itemSorter={null} verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
        <Scatter name="minor" data={minor} fill="var(--color-minor)" isAnimationActive={false} shape="circle" />
        <Scatter name="major" data={major} fill="var(--color-major)" isAnimationActive={false} shape="diamond" />
      </ScatterChart>
    </ChartContainer>
  )
}

// ─── distribution ────────────────────────────────────────────────────────────

const distConfig = { count: { label: "Time spent", color: "var(--chart-1)" } } satisfies ChartConfig

export function DistributionChart({ samples }: { samples: Sample[] }) {
  const { bins, marks, total } = useMemo(() => {
    const values = samples.map((s) => s.rss)
    const max = Math.max(1, ...values) * 1.02
    const [p50, p95, p99] = percentiles(values, [50, 95, 99])
    const bins = histogram(values, 32, max).map((b) => ({ x: (b.x0 + b.x1) / 2, x0: b.x0, x1: b.x1, count: b.count }))
    return { bins, marks: { p50, p95, p99 }, total: values.length }
  }, [samples])

  return (
    <ChartContainer config={distConfig} className="aspect-auto h-[200px] w-full">
      <AreaChart data={bins} margin={{ top: 22, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          domain={[0, "dataMax"]}
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          minTickGap={40}
          tickFormatter={(v) => formatBytes(v)}
        />
        <YAxis hide />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ stroke: "var(--faint)" }}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, p) => `${formatBytes(p[0].payload.x0)} – ${formatBytes(p[0].payload.x1)}`}
              formatter={(v) => (
                <div className="flex w-full justify-between gap-6">
                  <span className="text-muted-foreground">Time spent</span>
                  <span className="font-mono tabular-nums">{((Number(v) / total) * 100).toFixed(1)}%</span>
                </div>
              )}
            />
          }
        />
        <Area dataKey="count" type="stepAfter" stroke="var(--color-count)" strokeWidth={1.5} fill="var(--color-count)" fillOpacity={0.1} isAnimationActive={false} />
        {(["p50", "p95", "p99"] as const).map((k) => (
          <ReferenceLine
            key={k}
            x={marks[k]}
            stroke={k === "p99" ? "var(--signal)" : "var(--muted-foreground)"}
            strokeDasharray="3 3"
            label={{ value: k, position: "top", fontSize: 11, fontWeight: 600, fill: k === "p99" ? "var(--signal)" : "var(--muted-foreground)" }}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}
