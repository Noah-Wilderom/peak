import { useMemo } from "react"
import { motion } from "motion/react"
import { XIcon } from "lucide-react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Card } from "@/components/card"
import type { Proc, SystemInfo, SystemSample } from "@/lib/types"
import { hostAssessment, machineSeries } from "@/lib/machine"
import { formatBytes, formatClock, formatPercent } from "@/lib/format"

const memoryConfig = {
  memUsed: { label: "Machine in use", color: "var(--chart-1)" },
  procRss: { label: "Selected process", color: "var(--chart-5)" },
} satisfies ChartConfig

const loadConfig = {
  cpu: { label: "Machine CPU", color: "var(--chart-1)" },
  psiSome: { label: "Memory pressure", color: "var(--chart-5)" },
} satisfies ChartConfig

export function MachinePage({
  samples,
  system,
  proc,
  onClose,
}: {
  samples: SystemSample[]
  system: SystemInfo
  proc: Proc | null
  onClose: () => void
}) {
  const data = useMemo(() => machineSeries(samples, proc), [samples, proc])
  const last = samples.at(-1)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-4 px-10 pt-12 pb-10">
        <div className="mb-4 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-[650]">This machine.</h1>
            <p className="mt-3 max-w-xl text-[19px] leading-snug font-light text-muted-foreground">
              {system.hostname || "This host"} · {system.cpus} CPUs · {formatBytes(system.totalMemory)}. Whole-host figures from the last hour, not any single process.
            </p>
          </div>
          <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close">
            <XIcon />
          </Button>
        </div>
        {!last ? (
          <div className="rounded-card bg-secondary px-6 py-12 text-center">
            <h2 className="text-title">No machine samples yet.</h2>
            <p className="mt-2 text-sm text-muted-foreground">They arrive with the next tick.</p>
          </div>
        ) : (
          <Details last={last} data={data} cpus={system.cpus} proc={proc} />
        )}
      </div>
    </motion.div>
  )
}

function Details({ last, data, cpus, proc }: { last: SystemSample; data: ReturnType<typeof machineSeries>; cpus: number; proc: Proc | null }) {
  const host = hostAssessment(last)
  const used = last.memTotal - last.memAvailable
  const procRss = proc?.status === "running" ? proc.samples.at(-1)!.rss : null
  const axis = {
    dataKey: "t",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as [string, string],
    tickLine: false,
    axisLine: false,
    tickMargin: 10,
    tickFormatter: (t: number) => formatClock(t),
  }

  return (
    <>
      <div className={`rounded-card p-6 ${host.starved ? "bg-warning/10 ring-1 ring-warning/25 ring-inset" : "bg-secondary"}`}>
        <h2 className="text-title">{host.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{host.detail}</p>
        {procRss !== null && last.memTotal > 0 && (
          <p className="mt-2 text-sm tabular-nums">
            <span className="font-mono text-[12.5px]">{proc!.command}</span> holds {formatBytes(procRss)}, {formatPercent((procRss / last.memTotal) * 100)} of the machine.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile label="Machine memory" value={formatBytes(used)} hint={`of ${formatBytes(last.memTotal)} · ${formatBytes(last.memAvailable)} available`} />
        <Tile
          label="Swap"
          value={last.swapTotal > 0 ? formatBytes(last.swapTotal - last.swapFree) : "No swap"}
          hint={last.swapTotal > 0 ? `of ${formatBytes(last.swapTotal)}` : "None configured"}
        />
        <Tile
          label="Memory pressure"
          value={last.psiSome === null ? "Not reported" : formatPercent(last.psiSome)}
          hint={last.psiSome === null ? "The kernel doesn't expose PSI here" : `${formatPercent(last.psiFull ?? 0)} of tasks fully stalled`}
        />
        <Tile label="CPU" value={formatPercent(last.cpu)} hint={`100% is all ${cpus} CPUs · load ${last.load1.toFixed(2)}`} />
      </div>
      <Card title="Memory." subtitle="The whole machine against the selected process. Different scopes: the process is part of the machine's total.">
        <ChartContainer config={memoryConfig} className="aspect-auto h-[260px] w-full">
          <AreaChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis {...axis} />
            <YAxis domain={[0, last.memTotal || "auto"]} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatBytes(v)} />
            <ChartTooltip
              isAnimationActive={false}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_, p) => formatClock(p[0].payload.t)}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-6">
                      <span className="text-muted-foreground">{memoryConfig[name as keyof typeof memoryConfig].label}</span>
                      <span className="font-mono tabular-nums">{formatBytes(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
            <Area dataKey="memUsed" type="monotone" stroke="var(--color-memUsed)" strokeWidth={2} fill="var(--color-memUsed)" fillOpacity={0.08} isAnimationActive={false} dot={false} />
            <Area dataKey="procRss" type="monotone" stroke="var(--color-procRss)" strokeWidth={2} fill="none" isAnimationActive={false} dot={false} connectNulls={false} />
          </AreaChart>
        </ChartContainer>
      </Card>
      <Card title="Load." subtitle="Machine CPU (100% is every CPU, unlike a process's 100% per core) and memory pressure.">
        <ChartContainer config={loadConfig} className="aspect-auto h-[200px] w-full">
          <LineChart data={data} margin={{ top: 8, right: 20, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis {...axis} />
            <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
            <ChartTooltip
              isAnimationActive={false}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_, p) => formatClock(p[0].payload.t)}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-6">
                      <span className="text-muted-foreground">{loadConfig[name as keyof typeof loadConfig].label}</span>
                      <span className="font-mono tabular-nums">{formatPercent(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend verticalAlign="top" align="right" content={<ChartLegendContent className="justify-end pb-3" />} />
            <Line dataKey="cpu" type="monotone" stroke="var(--color-cpu)" strokeWidth={2} isAnimationActive={false} dot={false} />
            <Line dataKey="psiSome" type="monotone" stroke="var(--color-psiSome)" strokeWidth={2} isAnimationActive={false} dot={false} connectNulls={false} />
          </LineChart>
        </ChartContainer>
      </Card>
    </>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 rounded-card border border-border p-5">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-[20px] font-semibold tabular-nums">{value}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground" title={hint}>{hint}</p>
    </div>
  )
}
