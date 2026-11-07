import { useEffect, useState } from "react"
import { useMonitor } from "@/hooks/use-monitor"
import { AnimatePresence, motion } from "motion/react"
import { PauseIcon, PlayIcon, RotateCwIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MemoryChart } from "@/components/charts/memory-chart"
import { CpuChart } from "@/components/charts/cpu-chart"
import { IoChart } from "@/components/charts/io-chart"
import { TimelineProvider } from "@/components/charts/timeline"
import { LogsPanel, type LogJump } from "@/components/logs-panel"
import { ResourcesTab } from "@/components/resources-tab"
import { MemoryTab } from "@/components/memory-tab"
import { ProfilerTab } from "@/components/profiler-tab"
import { StatsTab } from "@/components/stats-tab"
import { ReportTab } from "@/components/report-tab"
import { TimeControls } from "@/components/time-controls"
import { Card } from "@/components/card"
import { Tween } from "@/components/tween"
import { Bytes } from "@/components/bytes"
import { CopyPid } from "@/components/copy-pid"
import { RuntimeTile, StatusPill } from "@/components/status"
import { TargetActions } from "@/components/target-actions"
import { monitor, type Proc, type SystemInfo, type TargetState } from "@/lib/monitor"
import { average, valueAgo, visibleSamples, type AxisMode, type RangeKey, type View } from "@/lib/series"
import { formatBytes, formatClock, formatDuration, formatOffset, formatPercent } from "@/lib/format"
import { cn } from "@/lib/utils"

const TIMELINE_TABS = new Set(["overview", "memory", "resources"])

export function ProcessDetail({ proc, paused, system: local, targets }: { proc: Proc; paused: boolean; system: SystemInfo; targets: TargetState[] }) {
  const running = proc.status === "running"
  const target = proc.target && targets.find((t) => t.spec.id === proc.target!.targetId)
  const linked = !proc.target || target?.state === "connected" || target?.state === "stale"
  // Capacity figures for a remote run are that target's, not this machine's.
  const system = target?.facts
    ? { totalMemory: target.facts.hostMemory, cpus: target.facts.cpus, hostname: target.facts.hostname, os: "linux" }
    : local
  const [view, setViewState] = useState<View>({ kind: "live", range: running ? "1m" : "all" })
  const [lastRange, setLastRange] = useState<RangeKey>(running ? "1m" : "all")
  const [axis, setAxis] = useState<AxisMode>("elapsed")
  const [tab, setTab] = useState("overview")
  const [jump, setJump] = useState<LogJump | null>(null)
  const { openRequest } = useMonitor()
  const opened = openRequest?.id === proc.id ? openRequest.seq : 0
  useEffect(() => {
    if (opened) setTab("profiler")
  }, [opened])
  const jumpToOutput = (t: number) => {
    setJump((j) => ({ t, seq: (j?.seq ?? 0) + 1 }))
    setTab("logs")
  }
  const setView = (v: View) => {
    if (v.kind === "live") setLastRange(v.range)
    setViewState(v)
  }

  const last = proc.samples.at(-1)!
  const elapsed = (proc.endedAt ?? last.t) - proc.startedAt

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-6 px-8 pt-7 pb-5">
        <div className="flex min-w-0 items-center gap-4">
          <RuntimeTile runtime={proc.runtime} size={48} />
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="truncate font-mono text-[22px] leading-tight font-semibold tracking-tight">{proc.command}</h1>
              <StatusPill proc={proc} />
              {proc.historical && (
                <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-secondary px-2.5 text-label whitespace-nowrap text-muted-foreground">
                  From history · {new Date(proc.startedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground tabular-nums">
              {proc.target && (
                <>
                  on <span className="font-semibold text-foreground">{proc.target.label}</span> <span className="text-faint">·</span>{" "}
                </>
              )}
              {proc.cwd} <span className="text-faint">·</span> <CopyPid pid={proc.pid} /> <span className="text-faint">·</span> started{" "}
              {formatClock(proc.startedAt)} <span className="text-faint">·</span> {running ? "up" : "ran"} {formatDuration(elapsed)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running && (
            <Button variant="outline" onClick={() => monitor.setPaused(!paused)}>
              {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              {paused ? "Resume" : "Freeze"}
            </Button>
          )}
          {proc.target ? (
            <TargetActions proc={proc} target={target} linked={linked} />
          ) : (
            <Button variant="outline" onClick={() => monitor.restart(proc.id)}>
              <RotateCwIcon data-icon="inline-start" />
              {running ? "Restart" : "Run again"}
            </Button>
          )}
          {running && !proc.target ? (
            <Button onClick={() => monitor.kill(proc.id)}>
              <SquareIcon data-icon="inline-start" className="fill-current" />
              Stop
            </Button>
          ) : running ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="icon" onClick={() => monitor.remove(proc.id)} aria-label="Remove">
                  <Trash2Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove from list (stays in History)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {proc.target && !linked && running && (
        <p role="status" className="mx-8 mb-4 rounded-2xl bg-warning/10 px-4 py-2.5 text-sm ring-1 ring-warning/25 ring-inset">
          <span className="font-semibold">No connection to {proc.target.label}.</span> It may still be running; peak can't tell from here. Data resumes after reconnecting, once it's verified to be the same process.
        </p>
      )}

      <TimelineProvider proc={proc} view={view} setView={setView} axis={axis} paused={paused} onJump={jumpToOutput}>
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <div className="px-8 pb-4">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="profiler">
                Profiler <span className="text-faint tabular-nums">{proc.snapshots.length + (proc.cpuProfiles?.length ?? 0) || ""}</span>
              </TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
              <TabsTrigger value="report">Report</TabsTrigger>
              <TabsTrigger value="logs">
                Output <span className="text-faint tabular-nums">{proc.logs.length}</span>
              </TabsTrigger>
              <TabsTrigger value="resources">
                Resources <span className="text-faint tabular-nums">{proc.children.length + 1}</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <AnimatePresence initial={false}>
            {TIMELINE_TABS.has(tab) && (
              <motion.div
                key="tc"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                className="shrink-0 overflow-hidden"
              >
                <div className="px-8 pb-4">
                  <TimeControls view={view} setView={setView} axis={axis} setAxis={setAxis} lastRange={lastRange} live={running && !paused} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <TabsContent value="overview" className="min-h-0 overflow-y-auto px-8 pb-8">
            <Overview proc={proc} view={view} />
          </TabsContent>
          <TabsContent value="memory" className="min-h-0 overflow-y-auto px-8 pb-8">
            <MemoryTab totalMemory={system.totalMemory} />
          </TabsContent>
          <TabsContent value="profiler" className="min-h-0 overflow-y-auto px-8 pb-8">
            <ProfilerTab proc={proc} />
          </TabsContent>
          <TabsContent value="stats" className="min-h-0 overflow-y-auto px-8 pb-8">
            <StatsTab proc={proc} system={system} />
          </TabsContent>
          <TabsContent value="report" className="min-h-0 overflow-y-auto px-8 pb-8">
            <ReportTab proc={proc} />
          </TabsContent>
          <TabsContent value="logs" className="min-h-0 px-8 pb-8">
            <LogsPanel proc={proc} jump={jump} />
          </TabsContent>
          <TabsContent value="resources" className="min-h-0 overflow-y-auto px-8 pb-8">
            <ResourcesTab />
          </TabsContent>
        </Tabs>
      </TimelineProvider>

      <AnimatePresence>
        {paused && running && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
            className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2"
          >
            <span className="inline-flex h-8 items-center gap-2 rounded-full bg-foreground px-4 text-xs font-semibold text-background">
              <PauseIcon className="size-3.5" />
              View frozen — still sampling in the background
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Overview({ proc, view }: { proc: Proc; view: View }) {
  // Tiles update with every sample; Tween eases between values so they stay readable.
  const running = proc.status === "running"
  const last = proc.samples.at(-1)!
  const windowed = visibleSamples(proc, view)
  const rssDelta = last.rss - valueAgo(proc.samples, "rss", 30_000)
  const noIo = proc.unavailable?.includes("io")

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          label="Memory"
          value={running ? <Bytes value={last.rss} /> : "—"}
          hint={
            running ? (
              <Tween value={rssDelta} format={(v) => `${v >= 0 ? "+" : "−"}${formatBytes(Math.abs(v))} in 30s`} />
            ) : (
              "Process ended"
            )
          }
        />
        <StatTile
          featured
          label={
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-signal" />
              Peak memory
            </span>
          }
          value={<Bytes value={proc.peak.rss} />}
          hint={`at T+${formatOffset(proc.peak.t - proc.startedAt)} · ${formatPercent(proc.peak.cpu)} CPU`}
        />
        <StatTile
          label="CPU"
          value={running ? <Tween value={last.cpu} format={formatPercent} /> : "—"}
          hint={
            <>
              avg <Tween value={average(windowed, "cpu")} format={formatPercent} /> · {proc.threads} threads
            </>
          }
        />
        <StatTile
          label="Disk I/O"
          value={noIo ? "Unreadable" : running ? <Bytes value={last.read + last.write} rate /> : "—"}
          hint={
            noIo ? (
              "Permissions don't allow reading this"
            ) : (
              <>
                <Bytes value={average(windowed, "read")} rate /> read · <Bytes value={average(windowed, "write")} rate /> write
              </>
            )
          }
        />
      </div>

      <Card title="Memory." subtitle="Resident set size and heap. Dashed blue marks the high-water mark. Drag to zoom; click a moment or event to see its output.">
        <MemoryChart />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="CPU." subtitle="User and kernel time across all cores — 100% is one full core.">
          <CpuChart />
        </Card>
        <Card title="Disk I/O." subtitle={noIo ? "Couldn't be read for this process: these flat lines mean unknown, not zero." : "Bytes read and written per second."}>
          <IoChart />
        </Card>
      </div>
    </motion.div>
  )
}

function StatTile({
  label,
  value,
  hint,
  featured,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint: React.ReactNode
  featured?: boolean
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-card p-5", featured ? "bg-secondary" : "border border-border bg-background")}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="text-heading tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground tabular-nums">{hint}</span>
    </div>
  )
}
