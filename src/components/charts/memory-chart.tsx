import { Area, AreaChart, CartesianGrid, Line, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatTimeLabel, useEasedYAxis, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { formatBytes } from "@/lib/format"

const config = {
  rss: { label: "Resident (RSS)", color: "var(--chart-1)" },
  heap: { label: "Heap used", color: "var(--chart-2)" },
} satisfies ChartConfig

export function MemoryChart({ height = 280 }: { height?: number }) {
  const { proc, data, from, to, xAxis, chart, selection } = useTimelineChart()
  const peak = proc.peak
  const y = useEasedYAxis(Math.max(peak.rss, visibleMax(data, from, to, ["rss"])), { bytes: true })
  const majors = proc.gc.filter((g) => g.kind === "major" && g.t >= from && g.t <= to)

  return (
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
              labelFormatter={(_, p) => formatTimeLabel(p[0].payload.t, proc)}
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
        {majors.map((g) => (
          <ReferenceLine key={g.t} x={g.t} stroke="var(--input)" strokeWidth={1} />
        ))}
        <Area
          dataKey="rss"
          type="monotone"
          stroke="var(--color-rss)"
          strokeWidth={2}
          fill="url(#fill-rss)"
          isAnimationActive={false}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
        />
        <Line
          dataKey="heap"
          type="monotone"
          stroke="var(--color-heap)"
          strokeWidth={2}
          strokeDasharray="5 3"
          isAnimationActive={false}
          dot={false}
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
  )
}
