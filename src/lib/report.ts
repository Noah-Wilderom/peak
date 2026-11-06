import { frameTotal, type AllocFrame, type Alert, type Proc } from "@/lib/types"
import { analyzeTrend, gcStats } from "@/lib/analysis"
import { average } from "@/lib/series"
import { formatBytes, formatDuration, formatMs, formatOffset, formatPercent } from "@/lib/format"
import { runOutcome } from "@/lib/history"

export type RunState = "running" | "finished" | "failed" | "interrupted" | "unknown"

export interface RunReport {
  command: string
  cwd: string
  pid: number
  runtime: Proc["runtime"]
  state: RunState
  outcome: string
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number
  verdict: { title: string; detail: string }
  memory: {
    peakRss: number
    peakAtMs: number
    /** Null when there are too few samples to judge a trend. */
    trend: { kind: string; bytesPerMin: number; r2: number } | null
  }
  avgCpu: number
  /** Null when no collector activity was observed: unknown, not zero. */
  gc: { collections: number; major: number; totalPauseMs: number; sharePercent: number } | null
  gcNote: string
  /** From the latest snapshot. Null when none was taken. */
  allocators: {
    snapshotAt: number
    heapUsed: number
    types: { name: string; count: number; retained: number }[]
    sites: { name: string; file: string | null; bytes: number }[]
  } | null
  alerts: Alert[]
  /** Remote runs only: where it ran, and stretches with no data. */
  target: { label: string; kind: string; launched: boolean } | null
  gaps: { from: number; to: number }[]
  /** Metrics that couldn't be read, so their totals mean nothing. */
  unavailable: string[]
}

const MIN_TREND_SAMPLES = 10

/** Frames doing the most allocating themselves, largest first. */
export function topSites(root: AllocFrame, limit = 5) {
  const out: { name: string; file: string | null; bytes: number }[] = []
  const visit = (f: AllocFrame) => {
    if (f.self > 0) out.push({ name: f.name, file: f.file ?? null, bytes: f.self })
    f.children.forEach(visit)
  }
  visit(root)
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, limit)
}

function runState(p: Proc): RunState {
  if (p.status === "running") return "running"
  if (p.signal === "peak closed") return "interrupted"
  if (p.signal === "ended while disconnected" || p.signal === "target rebooted" || p.signal === "monitoring stopped" || p.signal === "stopped with the session") return "unknown"
  return p.status === "crashed" ? "failed" : "finished"
}

function verdictFor(state: RunState, outcome: string, trend: RunReport["memory"]["trend"], alerts: number) {
  const suffix = alerts ? ` ${alerts} alert${alerts === 1 ? "" : "s"} fired.` : ""
  if (state === "failed") return { title: "Failed.", detail: `The run ended badly: ${outcome}.${suffix}` }
  if (state === "interrupted") {
    return { title: "Interrupted.", detail: `Peak closed before the run ended, so its real outcome and final figures are unknown.${suffix}` }
  }
  if (state === "unknown") {
    return { title: "Outcome unknown.", detail: `${outcome}: peak wasn't watching when it ended, so how it ended isn't known.${suffix}` }
  }
  const lead = state === "running" ? "Still running; figures so far." : "Finished cleanly."
  if (!trend) return { title: state === "running" ? "Running." : "Finished.", detail: `${lead} Too few samples to judge the memory trend.${suffix}` }
  if (trend.kind === "growing") {
    return { title: "Memory is growing.", detail: `${lead} Memory climbs at ${formatBytes(trend.bytesPerMin)}/min, the shape of a leak.${suffix}` }
  }
  return { title: state === "running" ? "Running." : "Finished.", detail: `${lead} Memory trend: ${trend.kind}.${suffix}` }
}

export function buildReport(p: Proc): RunReport {
  const last = p.samples.at(-1)!
  const end = p.endedAt ?? last.t
  const state = runState(p)
  const outcome = runOutcome(p)
  const alerts = p.alerts ?? []

  const t = analyzeTrend(p.samples)
  const trend = p.samples.length >= MIN_TREND_SAMPLES ? { kind: t.verdict, bytesPerMin: t.perMin, r2: t.r2 } : null

  const stats = gcStats(p, p.startedAt, end)
  const gc = stats.count
    ? { collections: stats.count, major: stats.major, totalPauseMs: stats.total, sharePercent: stats.overhead * 100 }
    : null
  const gcNote = gc ? "" : p.runtime === "rust" ? "No collector: ownership-based memory." : "No collections observed; a runtime agent reports these."

  const snap = p.snapshots.at(-1)
  return {
    command: p.command,
    cwd: p.cwd,
    pid: p.pid,
    runtime: p.runtime,
    state,
    outcome,
    exitCode: p.exitCode ?? null,
    signal: p.signal ?? null,
    startedAt: p.startedAt,
    endedAt: p.endedAt ?? null,
    durationMs: end - p.startedAt,
    verdict: verdictFor(state, outcome, trend, alerts.length),
    memory: { peakRss: p.peak.rss, peakAtMs: p.peak.t - p.startedAt, trend },
    avgCpu: average(p.samples, "cpu"),
    gc,
    gcNote,
    allocators: snap
      ? {
          snapshotAt: snap.t,
          heapUsed: snap.heapUsed,
          types: snap.entries.slice(0, 5).map((e) => ({ name: e.name, count: e.count, retained: e.retained })),
          sites: frameTotal(snap.sites) > 0 ? topSites(snap.sites) : [],
        }
      : null,
    alerts,
    target: p.target ? { label: p.target.label, kind: p.target.kind, launched: p.target.launched } : null,
    gaps: p.gaps ?? [],
    unavailable: p.unavailable ?? [],
  }
}

export function reportJson(r: RunReport) {
  return JSON.stringify(r, null, 2)
}

export function reportMarkdown(r: RunReport) {
  const lines = [
    `# Peak run report: \`${r.command}\``,
    "",
    `**${r.verdict.title}** ${r.verdict.detail}`,
    "",
    "## Summary",
    "",
    `- Outcome: ${r.outcome}`,
    `- Started: ${new Date(r.startedAt).toISOString()}`,
    `- Duration: ${formatDuration(r.durationMs)}${r.state === "running" ? " (so far)" : r.state === "interrupted" ? " (until peak closed)" : ""}`,
    `- Peak memory: ${formatBytes(r.memory.peakRss)} at T+${formatOffset(r.memory.peakAtMs)}`,
    `- Average CPU: ${formatPercent(r.avgCpu)} (100% is one core)`,
    `- Working directory: ${r.cwd}`,
    `- PID: ${r.pid} (${r.runtime})`,
    ...(r.target ? [`- Target: ${r.target.label} (${r.target.kind}), ${r.target.launched ? "launched by peak" : "attached"}`] : []),
    ...(r.gaps.length ? [`- Gaps in data: ${r.gaps.length}, ${formatDuration(r.gaps.reduce((a, g) => a + g.to - g.from, 0))} in total`] : []),
    ...(r.unavailable.length ? [`- Couldn't read: ${r.unavailable.join(", ")}`] : []),
    "",
    "## Garbage collection",
    "",
    r.gc
      ? `${r.gc.collections} collections (${r.gc.major} major), ${formatMs(r.gc.totalPauseMs)} paused, ${formatPercent(r.gc.sharePercent)} of the run.`
      : r.gcNote,
    "",
    "## Top allocators",
    "",
  ]
  if (r.allocators) {
    lines.push(`From the latest snapshot at T+${formatOffset(r.allocators.snapshotAt - r.startedAt)} (${formatBytes(r.allocators.heapUsed)} heap).`, "")
    lines.push("| Type | Objects | Retained |", "|---|---:|---:|")
    r.allocators.types.forEach((t) => lines.push(`| \`${t.name}\` | ${t.count} | ${formatBytes(t.retained)} |`))
    if (r.allocators.sites.length) {
      lines.push("", "Allocation sites:", "")
      r.allocators.sites.forEach((s) => lines.push(`- \`${s.name}\`${s.file ? ` (${s.file})` : ""}: ${formatBytes(s.bytes)}`))
    }
  } else {
    lines.push("No heap snapshot was taken.")
  }
  lines.push("", "## Alerts", "")
  if (r.alerts.length) r.alerts.forEach((a) => lines.push(`- T+${formatOffset(a.t - r.startedAt)}: ${a.message}`))
  else lines.push("None.")
  return lines.join("\n") + "\n"
}
