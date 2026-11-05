import { useEffect, useMemo, useState } from "react"
import { motion } from "motion/react"
import { CornerDownLeftIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { monitor, type Attachable } from "@/lib/monitor"
import { formatBytes } from "@/lib/format"

const SUGGESTIONS = ["bun run build", "npm test", "python main.py", "node server.js", "cargo build --release"]

/** The capture flow — also the app's empty state. */
export function CapturePage({ onClose }: { onClose?: () => void }) {
  const [command, setCommand] = useState("")
  const [cwd, setCwd] = useState("~")
  const [busy, setBusy] = useState(false)
  const run = async () => {
    // The submit button is disabled while empty or busy, which also blocks Enter-to-submit.
    setBusy(true)
    try {
      await monitor.capture(command.trim(), cwd.trim())
      setCommand("")
    } catch (e) {
      toast.error("Couldn't start process", { description: String(e) })
    } finally {
      setBusy(false)
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
      <div className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-1 flex-col px-10 pt-12 pb-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-[650]">Capture a process.</h1>
            <p className="mt-3 max-w-xl text-[19px] leading-snug font-light text-muted-foreground">
              Run a script through peak, or attach to something already running, and watch its memory, CPU and I/O as it
              happens.
            </p>
          </div>
          {onClose && (
            <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close">
              <XIcon />
            </Button>
          )}
        </div>

        <div className="mt-10 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-card bg-secondary p-6">
              <h2 className="text-title">Run a command.</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Node and Python get a profiling agent for heap snapshots and GC data.
              </p>
              <form
                className="mt-5 flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run()
                }}
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">Command</span>
                  <Input
                    autoFocus
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="bun run build"
                    className="bg-background font-mono"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">Working directory</span>
                  <Input value={cwd} onChange={(e) => setCwd(e.target.value)} className="bg-background font-mono" />
                </label>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setCommand(s)}
                      className="h-7 rounded-full bg-background px-3 font-mono text-[11px] text-ink-soft transition-colors hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <Button type="submit" size="lg" className="mt-2 self-start" disabled={!command.trim() || busy}>
                  {busy ? "Starting…" : "Run and capture"}
                  <CornerDownLeftIcon data-icon="inline-end" />
                </Button>
              </form>
            </section>

            <section className="rounded-card border border-border p-6">
              <h2 className="text-[15px] font-semibold">From your terminal.</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Prefix any command — output stays in your terminal and streams here too.
              </p>
              <code className="mt-4 block truncate rounded-full bg-secondary px-4 py-2 font-mono text-xs text-ink-soft select-text">
                peak run -- bun run build
              </code>
            </section>
          </div>

          <AttachList />
        </div>
      </div>
    </motion.div>
  )
}

function AttachList() {
  const [list, setList] = useState<Attachable[] | null>(null)
  const [filter, setFilter] = useState("")
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    monitor
      .listAttachable()
      .then((l) => live && setList(l))
      .catch((e) => toast.error("Couldn't list processes", { description: String(e) }))
    return () => {
      live = false
    }
  }, [nonce])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const l = list ?? []
    return q ? l.filter((p) => p.command.toLowerCase().includes(q) || String(p.pid).includes(q)) : l
  }, [list, filter])

  const attach = async (pid: number) => {
    try {
      await monitor.attach(pid)
    } catch (e) {
      toast.error("Couldn't attach", { description: String(e) })
    }
  }

  return (
    <section className="flex max-h-[640px] min-h-[420px] min-w-0 flex-col overflow-hidden rounded-card border border-border">
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0">
          <h2 className="text-title">Attach to a process.</h2>
          <p className="mt-1 text-sm text-muted-foreground">Your processes, largest first.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          onClick={() => {
            setList(null)
            setNonce((n) => n + 1)
          }}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="relative px-6 pt-4 pb-3">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-9.5 mt-0.5 size-4 -translate-y-1/2 text-faint" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by command or PID" className="pl-10" />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
        {list === null && <li className="py-10 text-center text-sm text-muted-foreground">Scanning processes…</li>}
        {list && shown.length === 0 && <li className="py-10 text-center text-sm text-muted-foreground">No matching processes.</li>}
        {shown.map((p) => (
          <li key={p.pid} className="min-w-0">
            <button
              onClick={() => attach(p.pid)}
              title={p.command}
              className="flex w-full min-w-0 items-center gap-4 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-secondary"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12.5px] font-medium">{p.command}</span>
                <span className="block truncate text-xs text-muted-foreground">{p.cwd || "—"}</span>
              </span>
              <span className="shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                <span className="block text-foreground">{formatBytes(p.rss)}</span>
                PID {p.pid}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
