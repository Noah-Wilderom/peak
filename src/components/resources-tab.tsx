import { useMemo } from "react"
import { motion } from "motion/react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card } from "@/components/card"
import { ChildrenTable } from "@/components/children-table"
import { useTimelineChart } from "@/components/charts/timeline"
import { childMemorySeries, reported } from "@/lib/resources"
import { formatBytes, formatMs } from "@/lib/format"

const SHADES = ["var(--comp-1)", "var(--comp-2)", "var(--comp-3)", "var(--comp-4)", "var(--comp-5)", "var(--chart-5)", "var(--warning)", "var(--success)"]

const handleConfig = {
  threads: { label: "Threads", color: "var(--chart-1)" },
  files: { label: "Files", color: "var(--chart-3)" },
  sockets: { label: "Sockets", color: "var(--chart-5)" },
  pipes: { label: "Pipes", color: "var(--chart-2)" },
} satisfies ChartConfig

const lagConfig = { loopLag: { label: "Lag (p99)", color: "var(--chart-1)" } } satisfies ChartConfig

function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

export function ResourcesTab() {
  const { proc, data, xAxis, chart, selection, timeLabel, dot } = useTimelineChart()
  const running = proc.status === "running"
  const ports = proc.ports ?? []
  const memory = useMemo(() => childMemorySeries(proc, data), [proc, data])
  const memoryConfig = Object.fromEntries(memory.series.map((s, i) => [s.key, { label: s.label, color: SHADES[i] }])) satisfies ChartConfig
  const zoom = selection && <ReferenceArea x1={selection.a} x2={selection.b} fill="var(--foreground)" fillOpacity={0.06} />

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="flex flex-col gap-4">
      <Card title="Memory by process." subtitle="The stack's height is the tree's total resident memory; each band is one process's share.">
        {memory.hasChildren ? (
          <ChartContainer config={memoryConfig} className="aspect-auto h-[240px] w-full">
            <AreaChart data={memory.rows} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis {...xAxis} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatBytes(v)} />
              <ChartTooltip
                isAnimationActive={false}
                content={
                  <ChartTooltipContent
                    indicator="line"
                    labelFormatter={(_, p) => `${timeLabel(p[0].payload.t)} · total ${formatBytes(p[0].payload.total)}`}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-6">
                        <span className="text-muted-foreground">{memoryConfig[String(name)].label}</span>
                        <span className="font-mono tabular-nums">{formatBytes(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
              {memory.series.map((s) => (
                <Area key={s.key} dataKey={s.key} stackId="tree" type="monotone" stroke={`var(--color-${s.key})`} fill={`var(--color-${s.key})`} fillOpacity={0.25} strokeWidth={1.5} isAnimationActive={false} dot={dot} />
              ))}
              {zoom}
            </AreaChart>
          </ChartContainer>
        ) : (
          <Unavailable>No child processes seen in this window; all memory belongs to the main process.</Unavailable>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Threads and handles."
          subtitle={proc.unavailable?.includes("ports") ? "Thread counts across the process tree. File and socket handles aren't tracked on this platform yet." : proc.unavailable?.includes("fds") ? "Handle counts couldn't be read for part of this tree (permissions), so these lines understate them." : "Across the process tree. A steady climb in files or sockets is a leak of its own."}
        >
          {reported(data, "threads") ? (
            <ChartContainer config={handleConfig} className="aspect-auto h-[200px] w-full">
              <LineChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis {...xAxis} />
                <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                <ChartTooltip
                  isAnimationActive={false}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
                      formatter={(value, name) => (
                        <div className="flex w-full items-center justify-between gap-6">
                          <span className="text-muted-foreground">{handleConfig[name as keyof typeof handleConfig].label}</span>
                          <span className="font-mono tabular-nums">{Number(value)}</span>
                        </div>
                      )}
                    />
                  }
                />
                <ChartLegend verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
                {(Object.keys(handleConfig) as (keyof typeof handleConfig)[]).map((k) => (
                  <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} isAnimationActive={false} dot={dot} />
                ))}
                {zoom}
              </LineChart>
            </ChartContainer>
          ) : (
            <Unavailable>This run didn't record thread or handle counts.</Unavailable>
          )}
        </Card>

        <Card title="Runtime lag." subtitle="How long the event loop or interpreter kept work waiting (p99).">
          {reported(data, "loopLag") ? (
            <ChartContainer config={lagConfig} className="aspect-auto h-[200px] w-full">
              <LineChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }} {...chart}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis {...xAxis} />
                <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatMs(v)} />
                <ChartTooltip
                  isAnimationActive={false}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, p) => timeLabel(p[0].payload.t)}
                      formatter={(value) => (
                        <div className="flex w-full items-center justify-between gap-6">
                          <span className="text-muted-foreground">Lag (p99)</span>
                          <span className="font-mono tabular-nums">{formatMs(Number(value))}</span>
                        </div>
                      )}
                    />
                  }
                />
                <Line dataKey="loopLag" type="monotone" stroke="var(--color-loopLag)" strokeWidth={2} isAnimationActive={false} dot={dot} />
                {zoom}
              </LineChart>
            </ChartContainer>
          ) : (
            <Unavailable>
              {proc.profiling ? "Waiting for the runtime agent's first reading." : "Not measured: lag needs a runtime agent (Node or Python launched through peak)."}
            </Unavailable>
          )}
        </Card>
      </div>

      <Card title="Listening ports." subtitle="TCP sockets the process tree is listening on.">
        {!running ? (
          <Unavailable>Ports are only known while the process runs.</Unavailable>
        ) : proc.unavailable?.includes("ports") ? (
          <Unavailable>Listening ports aren't tracked on this platform yet.</Unavailable>
        ) : ports.length === 0 ? (
          <Unavailable>Not listening on any TCP port.</Unavailable>
        ) : (
          <div className="-mx-6 -mb-6 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary hover:bg-secondary">
                  <TableHead className="pl-6 text-xs text-muted-foreground">Port</TableHead>
                  <TableHead className="text-xs text-muted-foreground">Protocol</TableHead>
                  <TableHead className="text-xs text-muted-foreground">Address</TableHead>
                  <TableHead className="pr-6 text-right text-xs text-muted-foreground">PID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ports.map((p) => (
                  <TableRow key={`${p.proto}-${p.port}`} className="hover:bg-secondary/50">
                    <TableCell className="pl-6 font-mono text-[12.5px]">{p.port}</TableCell>
                    <TableCell className="text-sm">{p.proto}</TableCell>
                    <TableCell className="font-mono text-[12.5px]">{p.addr}</TableCell>
                    <TableCell className="pr-6 text-right tabular-nums">{p.pid}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <ChildrenTable proc={proc} />
    </motion.div>
  )
}
