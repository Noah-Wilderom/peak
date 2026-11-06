import { useEffect, useMemo, useState } from "react"
import { motion } from "motion/react"
import { ArrowLeftIcon } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Card } from "@/components/card"
import { monitor, type Proc } from "@/lib/monitor"
import { alignRuns, bytesDelta, cpuDelta, durationDelta, runStats, type RunStats } from "@/lib/compare"
import { runOutcome } from "@/lib/history"
import { formatBytes, formatDuration, formatOffset, formatPercent } from "@/lib/format"
import { byteUnit, niceTicks } from "@/lib/series"

const config = {
  a: { label: "Run A", color: "var(--chart-1)" },
  b: { label: "Run B", color: "var(--chart-5)" },
} satisfies ChartConfig

/** Two stored runs side by side. Loads them without adding them to the session. */
export function ComparePage({ ids, onBack }: { ids: [string, string]; onBack: () => void }) {
  const [runs, setRuns] = useState<[Proc, Proc] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([monitor.loadRun(ids[0]), monitor.loadRun(ids[1])])
      .then(([a, b]) => setRuns([a, b]))
      .catch((e) => setError(String(e)))
  }, [ids])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-4 px-10 pt-12 pb-10">
        <div className="mb-4">
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            History
          </Button>
          <h1 className="mt-4 text-[44px] leading-[1.05] font-[650]">Compare runs.</h1>
          <p className="mt-3 max-w-xl text-[19px] leading-snug font-light text-muted-foreground">
            Memory over elapsed time, with both runs aligned at T+0. Differences read from run A to run B.
          </p>
        </div>
        {error && (
          <div className="rounded-card bg-secondary px-6 py-12 text-center">
            <h2 className="text-title">Couldn't load these runs.</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          </div>
        )}
        {runs && <Comparison a={runs[0]} b={runs[1]} />}
      </div>
    </motion.div>
  )
}

function Comparison({ a, b }: { a: Proc; b: Proc }) {
  const data = useMemo(() => alignRuns(a, b), [a, b])
  const sa = runStats(a)
  const sb = runStats(b)
  const top = Math.max(sa.peakRss, sb.peakRss, 1)
  const ticks = niceTicks(top * 1.05, 4, byteUnit(top))

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RunCard name="Run A" run={a} stats={sa} />
        <RunCard name="Run B" run={b} stats={sb} />
      </div>
      <Card title="Memory." subtitle="Resident set size against time since each run started. A line stops where its run ended.">
        <ChartContainer config={config} className="aspect-auto h-[320px] w-full">
          <LineChart data={data} margin={{ top: 16, right: 20, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="offset" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={10} tickFormatter={(v) => formatOffset(v)} />
            <YAxis domain={[0, ticks.at(-1)!]} ticks={ticks} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatBytes(v)} />
            <ChartTooltip
              cursor={{ stroke: "var(--faint)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_, p) => `T+${formatOffset(p[0].payload.offset)}`}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-6">
                      <span className="text-muted-foreground">{config[name as keyof typeof config].label}</span>
                      <span className="font-mono tabular-nums">{formatBytes(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend itemSorter={null} verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-4" />} />
            <Line dataKey="a" type="monotone" stroke="var(--color-a)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="b" type="monotone" stroke="var(--color-b)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ChartContainer>
      </Card>
      <Card title="Differences." subtitle="Average CPU is 100% per full core, so its difference is in percentage points.">
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,1.2fr))] gap-x-4 text-sm">
          <Cell head>Measure</Cell>
          <Cell head>Run A</Cell>
          <Cell head>Run B</Cell>
          <Cell head>Difference</Cell>
          <Cell>Peak memory</Cell>
          <Cell>{formatBytes(sa.peakRss)}</Cell>
          <Cell>{formatBytes(sb.peakRss)}</Cell>
          <Cell strong>{bytesDelta(sa.peakRss, sb.peakRss)}</Cell>
          <Cell>Duration</Cell>
          <Cell>{sa.durationMs === null ? "Still running" : formatDuration(sa.durationMs)}</Cell>
          <Cell>{sb.durationMs === null ? "Still running" : formatDuration(sb.durationMs)}</Cell>
          <Cell strong>{durationDelta(sa.durationMs, sb.durationMs)}</Cell>
          <Cell>Average CPU</Cell>
          <Cell>{formatPercent(sa.avgCpu)}</Cell>
          <Cell>{formatPercent(sb.avgCpu)}</Cell>
          <Cell strong>{cpuDelta(sa.avgCpu, sb.avgCpu)}</Cell>
          <Cell>Outcome</Cell>
          <Cell>{runOutcome(a)}</Cell>
          <Cell>{runOutcome(b)}</Cell>
          <Cell>{a.status === b.status ? "Same" : "Differs"}</Cell>
        </div>
      </Card>
    </>
  )
}

function RunCard({ name, run, stats }: { name: string; run: Proc; stats: RunStats }) {
  return (
    <div className="rounded-card border border-border p-5">
      <p className="text-xs font-semibold text-muted-foreground">{name}</p>
      <p className="mt-1 truncate font-mono text-[13px] font-semibold" title={run.command}>{run.command}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
        {new Date(run.startedAt).toLocaleString()} · {run.cwd}
      </p>
      {!stats.hasData && <p className="mt-2 text-xs font-semibold text-warning">No measurements were stored for this run.</p>}
      {stats.firstSampleAt > 5000 && (
        <p className="mt-2 text-xs text-muted-foreground">Its stored curve starts at T+{formatOffset(stats.firstSampleAt)}; nothing earlier was recorded.</p>
      )}
    </div>
  )
}

function Cell({ head, strong, children }: { head?: boolean; strong?: boolean; children: React.ReactNode }) {
  const tone = head ? "text-xs font-semibold text-muted-foreground" : strong ? "font-semibold tabular-nums" : "tabular-nums"
  return <div className={`border-b border-border py-2.5 ${tone}`}>{children}</div>
}
