import { useMemo, useState } from "react"
import { motion } from "motion/react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Bytes } from "@/components/bytes"
import { gcStats } from "@/lib/analysis"
import type { Proc, SystemInfo } from "@/lib/types"
import { average, maxOf, percentiles } from "@/lib/series"
import { formatBytes, formatClock, formatCount, formatDuration, formatMs, formatPercent, formatRate } from "@/lib/format"

type Row = [label: string, value: string, bytes?: number]
type Group = { title: string; rows: Row[] }

/** Every technical figure we know about a process, grouped for display/export. */
export function buildStats(proc: Proc, system: SystemInfo): Group[] {
  const s = proc.samples
  const last = s.at(-1)!
  const running = proc.status === "running"
  const elapsed = (proc.endedAt ?? last.t) - proc.startedAt
  const c = proc.counters
  const cpuTotal = c.cpuUserMs + c.cpuSysMs
  const [p50, p95, p99] = percentiles(s.map((x) => x.rss), [50, 95, 99])
  const gc = gcStats(proc, proc.startedAt, last.t)
  const now = (v: string) => (running ? v : "—")
  const noIo = proc.unavailable?.includes("io")
  const noFds = proc.unavailable?.includes("fds")
  const io = (v: string) => (noIo ? "Unavailable" : v)
  const handles = (v: string) => (noFds ? "Unavailable" : now(v))
  const t = proc.target

  return [
    ...(t
      ? [
          {
            title: "Target",
            rows: [
              ["Where", `${t.label} (${t.kind})`],
              ["How", t.launched ? "Launched by peak" : "Attached; only observed"],
              ["PID in its namespace", String(t.identity.pid)],
              ["PID namespace", t.identity.pidNs],
              ["Boot", t.identity.bootId],
              ["Start ticks", String(t.identity.startTicks)],
              ...(t.identity.containerId ? [["Container", t.identity.containerId] as Row] : []),
              ...(t.identity.podUid ? [["Pod", t.identity.podUid] as Row] : []),
              ["This machine's clock vs the target's", `${t.clockOffsetMs >= 0 ? "+" : "−"}${formatMs(Math.abs(t.clockOffsetMs))}`],
              ["Gaps in data", String(proc.gaps?.length ?? 0)],
            ] as Row[],
          },
        ]
      : []),
    {
      title: "Process",
      rows: [
        ["PID", String(proc.pid)],
        ["Parent PID", String(proc.ppid)],
        ["User", proc.user],
        ["Executable", proc.exe],
        ["Command", proc.command],
        ["Working directory", proc.cwd],
        ["Runtime", proc.runtime],
        ["State", proc.status + (proc.exitCode != null ? ` (code ${proc.exitCode}${proc.signal ? `, ${proc.signal}` : ""})` : "")],
        ["Started", `${new Date(proc.startedAt).toLocaleDateString()} ${formatClock(proc.startedAt)}`],
        [running ? "Uptime" : "Ran for", formatDuration(elapsed)],
        ["Nice", String(proc.nice)],
        ["Threads", now(String(proc.threads))],
        ["Child processes", now(String(proc.children.length))],
      ],
    },
    {
      title: "Memory",
      rows: [
        ["Resident (RSS)", now(formatBytes(last.rss)), running ? last.rss : undefined],
        ["Peak RSS", `${formatBytes(proc.peak.rss)} at T+${formatDuration(proc.peak.t - proc.startedAt)}`, proc.peak.rss],
        ["RSS p50 / p95 / p99", `${formatBytes(p50)} / ${formatBytes(p95)} / ${formatBytes(p99)}`],
        [t ? "Share of the target's host memory" : "Share of system memory", now(formatPercent((last.rss / system.totalMemory) * 100))],
        ["Virtual size", now(formatBytes(proc.vsz)), running ? proc.vsz : undefined],
        ["Swap", now(formatBytes(proc.swap)), running ? proc.swap : undefined],
        ["Heap used / reserved", now(`${formatBytes(last.heap)} / ${formatBytes(last.heapTotal)}`)],
        ["External / buffers", now(formatBytes(last.external)), running ? last.external : undefined],
        ["Code", now(formatBytes(last.code)), running ? last.code : undefined],
        ["Stacks", now(formatBytes(last.stack)), running ? last.stack : undefined],
        ["Minor page faults", formatCount(c.minorFaults)],
        ["Major page faults", formatCount(c.majorFaults)],
        ["Peak allocation rate", formatRate(maxOf(s, "alloc"))],
      ],
    },
    {
      title: "CPU",
      rows: [
        ["Current", now(formatPercent(last.cpu))],
        ["Average", formatPercent(average(s, "cpu"))],
        ["Peak", formatPercent(maxOf(s, "cpu"))],
        ["User time", formatMs(c.cpuUserMs)],
        ["System time", formatMs(c.cpuSysMs)],
        ["User / system split", cpuTotal ? `${((c.cpuUserMs / cpuTotal) * 100).toFixed(0)}% / ${((c.cpuSysMs / cpuTotal) * 100).toFixed(0)}%` : "—"],
        ["Cores used (avg)", `${(average(s, "cpu") / 100).toFixed(2)} of ${system.cpus}`],
        ["Voluntary context switches", formatCount(c.ctxVoluntary)],
        ["Involuntary context switches", formatCount(c.ctxInvoluntary)],
        ["System calls", c.syscalls ? formatCount(c.syscalls) : "—"],
      ],
    },
    {
      title: "I/O",
      rows: [
        ["Total read", io(formatBytes(c.readTotal)), noIo ? undefined : c.readTotal],
        ["Total written", io(formatBytes(c.writeTotal)), noIo ? undefined : c.writeTotal],
        ["Average read rate", io(formatRate(average(s, "read")))],
        ["Average write rate", io(formatRate(average(s, "write")))],
        ["Peak read rate", io(formatRate(maxOf(s, "read")))],
        ["Peak write rate", io(formatRate(maxOf(s, "write")))],
        ["Open files", handles(String(proc.fds.files))],
        ["Sockets", handles(String(proc.fds.sockets))],
        ["Pipes", handles(String(proc.fds.pipes))],
      ],
    },
    {
      title: "Garbage collection",
      rows: proc.hasGc
        ? [
            ["Collections", `${formatCount(gc.count)} (${formatCount(gc.major)} major)`],
            ["Total pause", formatMs(gc.total)],
            ["Pause p50 / p99 / max", `${formatMs(gc.p50)} / ${formatMs(gc.p99)} / ${formatMs(gc.max)}`],
            ["Time paused", formatPercent(gc.overhead * 100)],
            ["Reclaimed", formatBytes(gc.freed), gc.freed],
          ]
        : [["Collector", proc.runtime === "rust" ? "None — ownership-based" : "Not observed"]],
    },
  ]
}

export function StatsTab({ proc, system }: { proc: Proc; system: SystemInfo }) {
  const groups = useMemo(() => buildStats(proc, system), [proc, system])
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const json = Object.fromEntries(groups.map((g) => [g.title, Object.fromEntries(g.rows.map(([k, v]) => [k, v]))]))
    await navigator.clipboard.writeText(JSON.stringify(json, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Live — updates with every sample. Hover a size for exact bytes.</p>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "Copied" : "Copy as JSON"}
        </Button>
      </div>
      <div className="columns-1 gap-4 xl:columns-2">
        {groups.map((g) => (
          <section key={g.title} className="mb-4 break-inside-avoid rounded-card border border-border p-6">
            <h2 className="mb-3 text-[15px] font-semibold">{g.title}.</h2>
            <dl className="divide-y divide-border">
              {g.rows.map(([k, v, bytes]) => (
                <div key={k} className="flex items-baseline justify-between gap-6 py-2">
                  <dt className="shrink-0 text-sm text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate text-right font-mono text-[12.5px] tabular-nums select-text" title={v}>
                    {bytes === undefined ? v : <Bytes value={bytes}>{v}</Bytes>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </motion.div>
  )
}
