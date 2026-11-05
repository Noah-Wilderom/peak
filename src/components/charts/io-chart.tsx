import { Area, AreaChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatTimeLabel, useEasedYAxis, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { formatBytes, formatRate } from "@/lib/format"

const config = {
  read: { label: "Read", color: "var(--chart-1)" },
  write: { label: "Write", color: "var(--chart-2)" },
} satisfies ChartConfig

export function IoChart() {
  const { proc, data, from, to, xAxis, chart, selection } = useTimelineChart()
  const y = useEasedYAxis(visibleMax(data, from, to, ["read", "write"], true), { bytes: true, count: 3, min: 1024 })

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
      <AreaChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
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
                  <span className="font-mono tabular-nums">{formatRate(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend itemSorter={null} verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
        <Area dataKey="read" stackId="io" type="step" stroke="var(--color-read)" strokeWidth={1.5} fill="var(--color-read)" fillOpacity={0.12} isAnimationActive={false} dot={false} />
        <Area dataKey="write" stackId="io" type="step" stroke="var(--color-write)" strokeWidth={1.5} fill="var(--color-write)" fillOpacity={0.2} isAnimationActive={false} dot={false} />
        {selection && <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--foreground)" fillOpacity={0.06} />}
      </AreaChart>
    </ChartContainer>
  )
}
