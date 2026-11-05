import { Treemap } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import type { HeapEntry } from "@/lib/types"
import { formatBytes, formatCount } from "@/lib/format"
import { inkOn, inkRamp } from "@/lib/ramp"
import { useTheme } from "@/hooks/use-theme"

const config = { size: { label: "Retained" } } satisfies ChartConfig

export interface TreemapEntry extends HeapEntry {
  delta: number
}

interface CellProps {
  x?: number
  y?: number
  width?: number
  height?: number
  name?: string
  shade?: number
  retained?: number
  depth?: number
  dark?: boolean
}

function Cell({ x = 0, y = 0, width = 0, height = 0, name, shade = 0, retained = 0, depth, dark }: CellProps) {
  if (depth !== 1) return null
  const showLabel = width > 64 && height > 34
  return (
    <g>
      <rect
        x={x + 1}
        y={y + 1}
        width={Math.max(0, width - 2)}
        height={Math.max(0, height - 2)}
        rx={Math.min(10, width / 4, height / 4)}
        fill={inkRamp(shade, dark)}
      />
      {showLabel && (
        <>
          <text x={x + 10} y={y + 20} fill={inkOn(shade, dark)} fontSize={12} fontWeight={600} fontFamily="var(--font-mono)">
            {name!.length * 7 > width - 16 ? `${name!.slice(0, Math.max(1, Math.floor((width - 24) / 7)))}…` : name}
          </text>
          {height > 48 && (
            <text x={x + 10} y={y + 36} fill={inkOn(shade, dark)} fillOpacity={0.7} fontSize={11}>
              {formatBytes(retained)}
            </text>
          )}
        </>
      )}
    </g>
  )
}

export function HeapTreemap({ entries }: { entries: TreemapEntry[] }) {
  const { dark } = useTheme()
  const maxGrowth = Math.max(1, ...entries.map((e) => e.delta))
  const data = entries.map((e) => ({
    ...e,
    size: e.retained,
    // Stronger shade = grew more since the previous snapshot. Unchanged types stay faint.
    shade: 0.08 + 0.92 * Math.max(0, e.delta / maxGrowth),
  }))

  return (
    <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
      <Treemap data={data} dataKey="size" nameKey="name" isAnimationActive={false} content={<Cell dark={dark} />}>
        <ChartTooltip
          isAnimationActive={false}
          content={(p) => <TreemapTooltip active={p.active} payload={p.payload} />}
        />
      </Treemap>
    </ChartContainer>
  )
}

/** Tooltip body for a treemap cell (exported for tests). */
export function TreemapTooltip({ active, payload }: { active?: boolean; payload?: readonly { payload?: unknown }[] }) {
  const e = payload?.[0]?.payload as TreemapEntry | undefined
  if (!active || !e) return null
  return (
    <div className="grid min-w-48 gap-1.5 rounded-2xl border border-border bg-background px-3 py-2.5 text-xs shadow-xl">
      <span className="font-mono font-semibold">{e.name}</span>
      <Row label="Objects" value={formatCount(e.count)} />
      <Row label="Shallow size" value={formatBytes(e.shallow)} />
      <Row label="Retained size" value={formatBytes(e.retained)} />
      <Row label="Since previous" value={`${e.delta >= 0 ? "+" : "−"}${formatBytes(Math.abs(e.delta))}`} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  )
}
