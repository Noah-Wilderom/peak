import { Area, AreaChart, CartesianGrid, Line, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useEasedYAxis, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { MarkerStrip } from "@/components/charts/marker-strip"
import { formatBytes } from "@/lib/format"
import { MARKER_STYLE, timelineMarkers } from "@/lib/markers"

const config = {
  rss: { label: "Resident (RSS)", color: "var(--chart-1)" },
  heap: { label: "Heap used", color: "var(--chart-2)" },
} satisfies ChartConfig

export function MemoryChart({ height = 280 }: { height?: number }) {
  const { proc, data, from, to, xAxis, chart, selection, timeLabel, dot } = useTimelineChart()
  const peak = proc.peak
  const y = useEasedYAxis(Math.max(peak.rss, visibleMax(data, from, to, ["rss"])), { bytes: true })
  const markers = timelineMarkers(proc, from, to)

  return (
    <>
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={data} margin={{ top: 16, right: 20, left: 8, bottom: 0 }} {...chart}>
        <defs>
          <linearGradient id="fill-rss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-rss)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--color-rss)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis {...xAxis} />
        <YAxis {...y} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatBytes(v)} />
        <ChartTooltip
          cursor={{ stroke: "var(--faint)", strokeWidth: 1 }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="text-muted-foreground">{config[name as keyof typeof config]?.label}</span>
                  <span className="font-mono tabular-nums">{formatBytes(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <ReferenceLine
          y={peak.rss}
          stroke="var(--signal)"
          strokeDasharray="4 4"
          strokeWidth={1}
          label={{
            value: `Peak ${formatBytes(peak.rss)}`,
            position: "insideTopLeft",
            fill: "var(--signal)",
            fontSize: 11,
            fontWeight: 600,
            dy: -14,
          }}
        />
        {(proc.gaps ?? []).map((g) => (
          <ReferenceArea
            key={g.from}
            x1={Math.max(g.from, from)}
            x2={Math.min(g.to, to)}
            fill="var(--warning)"
            fillOpacity={0.12}
            label={{ value: "No data", position: "insideTop", fill: "var(--warning)", fontSize: 11 }}
          />
        ))}
        {markers.map((m) => (
          <ReferenceLine key={`${m.kind}-${m.t}`} x={m.t} stroke={MARKER_STYLE[m.kind].color} strokeOpacity={m.kind === "stderr" ? 0.2 : 0.55} strokeWidth={1} />
        ))}
        <Area
          dataKey="rss"
          type="monotone"
          stroke="var(--color-rss)"
          strokeWidth={2}
          fill="url(#fill-rss)"
          isAnimationActive={false}
          dot={dot}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
        />
        <Line
          dataKey="heap"
          type="monotone"
          stroke="var(--color-heap)"
          strokeWidth={2}
          strokeDasharray="5 3"
          isAnimationActive={false}
          dot={dot}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
        />
        {peak.t >= from && peak.t <= to && (
          <ReferenceDot x={peak.t} y={peak.rss} r={5} fill="var(--signal)" stroke="var(--background)" strokeWidth={2} />
        )}
        {selection && (
          <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--foreground)" fillOpacity={0.06} />
        )}
        <ChartLegend
          itemSorter={null}
          verticalAlign="top"
          align="right"
          content={<ChartLegendContent className="justify-end pb-4" />}
        />
      </AreaChart>
    </ChartContainer>
    <MarkerStrip markers={markers} from={from} to={to} />
    </>
  )
}
