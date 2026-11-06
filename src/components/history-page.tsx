import { useCallback, useEffect, useMemo, useState } from "react"
import { motion } from "motion/react"
import { GitCompareIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RuntimeTile, StatusDot } from "@/components/status"
import { monitor, type RunSummary } from "@/lib/monitor"
import { groupRuns, runOutcome, toggleSelection } from "@/lib/history"
import { formatBytes, formatDuration, formatPercent } from "@/lib/format"
import { cn } from "@/lib/utils"

interface HistoryPageProps {
  onClose: () => void
  /** A stored run was opened into the session. */
  onOpened: () => void
  onCompare: (a: string, b: string) => void
}

/** Every stored run, grouped by command: search, reopen, delete, pick two to compare. */
export function HistoryPage({ onClose, onOpened, onCompare }: HistoryPageProps) {
  const [query, setQuery] = useState("")
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])

  const load = useCallback(async (q: string) => {
    try {
      setRuns(await monitor.listRuns(q.trim() || undefined))
    } catch (e) {
      toast.error("Couldn't read history", { description: String(e) })
      setRuns([])
    }
  }, [])

  useEffect(() => {
    void load(query)
  }, [query, load])

  const groups = useMemo(() => groupRuns(runs ?? []), [runs])

  const open = async (id: string) => {
    try {
      await monitor.openRun(id)
      onOpened()
    } catch (e) {
      toast.error("Couldn't open run", { description: String(e) })
    }
  }

  const remove = async (id: string) => {
    try {
      await monitor.deleteRun(id)
      setSelected((s) => s.filter((x) => x !== id))
      await load(query)
    } catch (e) {
      toast.error("Couldn't delete run", { description: String(e) })
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-col px-10 pt-12 pb-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-[650]">History.</h1>
            <p className="mt-3 max-w-xl text-[19px] leading-snug font-light text-muted-foreground">
              Every run peak has recorded, kept across restarts. Open one to inspect it, or pick two to compare.
            </p>
          </div>
          <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close">
            <XIcon />
          </Button>
        </div>

        <div className="mt-8 flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by command"
              aria-label="Search history"
              className="pl-10"
            />
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">{selected.length} of 2 selected</span>
          <Button disabled={selected.length !== 2} onClick={() => onCompare(selected[0], selected[1])}>
            <GitCompareIcon data-icon="inline-start" />
            Compare
          </Button>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.command} className="overflow-hidden rounded-card border border-border">
              <header className="flex items-center gap-3 bg-secondary px-5 py-3">
                <RuntimeTile runtime={g.runs[0].runtime} size={28} />
                <h2 className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{g.command}</h2>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {g.runs.length} {g.runs.length === 1 ? "run" : "runs"}
                </span>
              </header>
              <ul className="divide-y divide-border">
                {g.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    checked={selected.includes(run.id)}
                    selectionFull={selected.length >= 2}
                    onToggle={() => setSelected((s) => toggleSelection(s, run.id))}
                    onOpen={() => void open(run.id)}
                    onDelete={() => void remove(run.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {runs && groups.length === 0 && (
            <div className="rounded-card bg-secondary px-6 py-12 text-center">
              <h2 className="text-title">{query.trim() ? "No matching runs." : "No runs recorded yet."}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {query.trim() ? "Try a different part of the command." : "Runs appear here once peak has monitored something."}
              </p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function RunRow({
  run,
  checked,
  selectionFull,
  onToggle,
  onOpen,
  onDelete,
}: {
  run: RunSummary
  checked: boolean
  selectionFull: boolean
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const running = run.status === "running"
  const started = new Date(run.startedAt)
  const label = `${run.command}, started ${started.toLocaleString()}`

  return (
    <li className="flex items-center gap-4 px-5 py-3 hover:bg-secondary/50">
      <input
        type="checkbox"
        checked={checked}
        disabled={!checked && selectionFull}
        onChange={onToggle}
        aria-label={`Select ${label} to compare`}
        className="size-4 shrink-0 accent-foreground disabled:opacity-40"
      />
      <span className="flex w-36 shrink-0 items-center gap-2 text-sm">
        <StatusDot status={run.status} />
        <span className={cn("truncate", run.status === "crashed" && "text-danger")}>{runOutcome(run)}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground tabular-nums">
        {started.toLocaleDateString()} {started.toLocaleTimeString()} · {run.cwd}
      </span>
      <Figure label="Ran" value={run.endedAt != null ? formatDuration(run.endedAt - run.startedAt) : "—"} />
      <Figure label="Peak" value={formatBytes(run.peakRss)} />
      <Figure label="Avg CPU" value={formatPercent(run.avgCpu)} />
      <Button size="sm" variant="outline" onClick={onOpen} aria-label={`Open ${label}`}>
        Open
      </Button>
      {confirming ? (
        <span className="flex items-center gap-1">
          <Button size="sm" onClick={onDelete} aria-label={`Confirm deleting ${label}`}>
            Delete
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button
          size="icon"
          variant="secondary"
          disabled={running}
          title={running ? "Stop the process before deleting its history" : undefined}
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${label}`}
        >
          <Trash2Icon />
        </Button>
      )}
    </li>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="w-20 shrink-0 text-right">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span className="block text-sm tabular-nums">{value}</span>
    </span>
  )
}
