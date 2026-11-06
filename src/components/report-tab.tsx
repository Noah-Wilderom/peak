import { useMemo, useState } from "react"
import { motion } from "motion/react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/card"
import type { Proc } from "@/lib/types"
import { buildReport, reportJson, reportMarkdown } from "@/lib/report"
import { formatBytes, formatCount, formatDuration, formatMs, formatOffset, formatPercent } from "@/lib/format"

const TONE = {
  running: "bg-secondary",
  finished: "bg-secondary",
  failed: "bg-danger/10 ring-1 ring-danger/25 ring-inset",
  interrupted: "bg-warning/10 ring-1 ring-warning/25 ring-inset",
  unknown: "bg-warning/10 ring-1 ring-warning/25 ring-inset",
}

export function ReportTab({ proc }: { proc: Proc }) {
  const report = useMemo(() => buildReport(proc), [proc])
  const [copied, setCopied] = useState<"md" | "json" | null>(null)

  const copy = async (kind: "md" | "json") => {
    try {
      await navigator.clipboard.writeText(kind === "md" ? reportMarkdown(report) : reportJson(report))
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch (e) {
      toast.error("Couldn't copy the report", { description: String(e) })
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy("md")}>
          {copied === "md" ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied === "md" ? "Copied" : "Copy Markdown"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copy("json")}>
          {copied === "json" ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied === "json" ? "Copied" : "Copy JSON"}
        </Button>
      </div>

      <div className={`rounded-card p-6 ${TONE[report.state]}`}>
        <p className="text-xs font-semibold text-muted-foreground">Verdict</p>
        <h2 className="mt-2 text-heading">{report.verdict.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{report.verdict.detail}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile label="Peak memory" value={formatBytes(report.memory.peakRss)} hint={`at T+${formatOffset(report.memory.peakAtMs)}`} />
        <Tile
          label="Duration"
          value={formatDuration(report.durationMs)}
          hint={report.state === "running" ? "so far" : report.state === "interrupted" ? "until peak closed" : report.state === "unknown" ? "until last seen" : "start to exit"}
        />
        <Tile label="Outcome" value={report.outcome} hint={report.exitCode === null ? "No exit code recorded" : `Exit code ${report.exitCode}`} />
        <Tile
          label="Time in GC"
          value={report.gc ? formatPercent(report.gc.sharePercent) : "Not observed"}
          hint={report.gc ? `${formatCount(report.gc.collections)} collections · ${formatMs(report.gc.totalPauseMs)} paused` : report.gcNote}
        />
      </div>

      {(report.target || report.unavailable.length > 0) && (
        <p className="px-1 text-sm text-muted-foreground">
          {report.target && `On ${report.target.label} (${report.target.kind}), ${report.target.launched ? "launched by peak" : "attached"}.`}
          {report.gaps.length > 0 && ` ${report.gaps.length} ${report.gaps.length === 1 ? "gap" : "gaps"} in the data from lost connections.`}
          {report.unavailable.length > 0 && ` Couldn't read: ${report.unavailable.join(", ")}.`}
        </p>
      )}

      <Card title="Top allocators." subtitle={report.allocators ? `From the latest snapshot, at T+${formatOffset(report.allocators.snapshotAt - report.startedAt)}.` : undefined}>
        {report.allocators ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ol className="flex flex-col divide-y divide-border">
              {report.allocators.types.map((t) => (
                <li key={t.name} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="min-w-0 truncate font-mono text-[12.5px]">{t.name}</span>
                  <span className="shrink-0 tabular-nums">{formatBytes(t.retained)}</span>
                </li>
              ))}
            </ol>
            <ol className="flex flex-col divide-y divide-border">
              {report.allocators.sites.map((s) => (
                <li key={`${s.name}-${s.file}`} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="min-w-0 truncate font-mono text-[12.5px]" title={s.file ?? undefined}>{s.name}</span>
                  <span className="shrink-0 tabular-nums">{formatBytes(s.bytes)}</span>
                </li>
              ))}
              {report.allocators.sites.length === 0 && <li className="py-2 text-sm text-muted-foreground">No allocation sites in this snapshot.</li>}
            </ol>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No heap snapshot was taken, so allocators are unknown.</p>
        )}
      </Card>

      <Card title="Alerts.">
        {report.alerts.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {report.alerts.map((a) => (
              <li key={`${a.kind}-${a.t}`} className="flex items-baseline gap-4 py-2 text-sm">
                <span className="w-14 shrink-0 text-muted-foreground tabular-nums">T+{formatOffset(a.t - report.startedAt)}</span>
                <span className="min-w-0">{a.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No alerts fired during this run.</p>
        )}
      </Card>
    </motion.div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 rounded-card border border-border p-5">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-[20px] font-semibold tabular-nums" title={value}>{value}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground" title={hint}>{hint}</p>
    </div>
  )
}
