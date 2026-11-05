import { Area, AreaChart, YAxis } from "recharts"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import type { Sample } from "@/lib/types"

const config = { rss: { label: "Memory", color: "var(--chart-1)" } } satisfies ChartConfig

export function Sparkline({ data, muted }: { data: Sample[]; muted?: boolean }) {
  return (
    <ChartContainer
      config={config}
      initialDimension={{ width: 72, height: 22 }}
      className="pointer-events-none aspect-auto h-[22px] w-[72px]"
      style={muted ? ({ "--color-rss": "var(--faint)" } as React.CSSProperties) : undefined}
    >
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <YAxis hide domain={[0, "dataMax"]} />
        <Area
          dataKey="rss"
          type="monotone"
          stroke="var(--color-rss)"
          strokeWidth={1.5}
          fill="var(--color-rss)"
          fillOpacity={0.06}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
