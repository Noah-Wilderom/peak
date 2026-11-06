import { Area, AreaChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useEasedYAxis, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { formatPercent } from "@/lib/format"

const config = {
  cpuUser: { label: "User", color: "var(--chart-1)" },
  cpuSys: { label: "System", color: "var(--chart-2)" },
} satisfies ChartConfig

export function CpuChart() {
  const { data, from, to, xAxis, chart, selection, timeLabel, dot } = useTimelineChart()
  const y = useEasedYAxis(visibleMax(data, from, to, ["cpuUser", "cpuSys"], true), { min: 100 })

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
      <AreaChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis {...xAxis} />
        <YAxis {...y} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
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
                  <span className="font-mono tabular-nums">{formatPercent(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend itemSorter={null} verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
        <Area
          dataKey="cpuUser"
          stackId="cpu"
          type="monotone"
          stroke="var(--color-cpuUser)"
          strokeWidth={2}
          fill="var(--color-cpuUser)"
          fillOpacity={0.1}
          isAnimationActive={false}
          dot={dot}
        />
        <Area
          dataKey="cpuSys"
          stackId="cpu"
          type="monotone"
          stroke="var(--color-cpuSys)"
          strokeWidth={2}
          fill="var(--color-cpuSys)"
          fillOpacity={0.15}
          isAnimationActive={false}
          dot={dot}
        />
        {selection && <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--foreground)" fillOpacity={0.06} />}
      </AreaChart>
    </ChartContainer>
  )
}
