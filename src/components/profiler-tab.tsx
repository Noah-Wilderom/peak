import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { CameraIcon, CircleDotIcon, RecycleIcon, SearchCodeIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { HeapTreemap } from "@/components/charts/heap-treemap"
import { FlameGraph } from "@/components/flame-graph"
import { Segmented } from "@/components/segmented"
import { Card } from "@/components/card"
import { Bytes } from "@/components/bytes"
import { monitor, type CpuSampling, type Proc } from "@/lib/monitor"
import { diffSnapshots, topGrower } from "@/lib/analysis"
import { formatBytes, formatClock, formatCount, formatMs, formatOffset } from "@/lib/format"
import { cn } from "@/lib/utils"

export function ProfilerTab({ proc }: { proc: Proc }) {
  const [mode, setMode] = useState<"heap" | "cpu">("heap")
  const available = proc.profiling || proc.snapshots.length > 0 || (proc.cpuProfiles?.length ?? 0) > 0

  if (!available) {
    return (
      <div className="flex flex-col items-center rounded-card bg-secondary px-12 py-16 text-center">
        <SearchCodeIcon className="size-6 text-muted-foreground" />
        <h2 className="mt-4 text-title">Heap and CPU profiling aren't available.</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Peak injects a profiling agent into Node and Python processes it launches. Run the process through peak (or
          <code className="mx-1 rounded-full bg-background px-2 py-0.5 font-mono text-xs">peak run --</code>) to get
          snapshots, allocation sites and CPU profiles.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        className="self-start"
        value={mode}
        onChange={setMode}
        options={[
          { value: "heap", label: "Heap" },
          { value: "cpu", label: "CPU" },
        ]}
      />
      {mode === "heap" ? <HeapProfiler proc={proc} /> : <CpuProfiler proc={proc} />}
    </div>
  )
}

const RECORDINGS = [5000, 10_000]

/** What a profile's time actually means, per collection method. */
const SAMPLING_NOTE: Record<CpuSampling, string> = {
  v8: "Sampled by V8 on the main JS thread. Event-loop waits show as (idle); synchronous blocking calls count under the frame that made them, so this isn't purely on-CPU time.",
  stack: "Python stack sampled on a timer on the main thread, running or not. Sleeps, I/O and lock waits are included, so this is elapsed time, not on-CPU time.",
  unknown: "Sampling method wasn't recorded; time may include blocking.",
}

function CpuProfiler({ proc }: { proc: Proc }) {
  const profiles = proc.cpuProfiles ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [recording, setRecording] = useState<{ ms: number; startedAt: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const profile = profiles.find((p) => p.id === selectedId) ?? profiles.at(-1)
  const running = proc.status === "running"

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed(Date.now() - recording.startedAt), 100)
    return () => clearInterval(timer)
  }, [recording])

  const record = async (ms: number) => {
    setError(null)
    setElapsed(0)
    setRecording({ ms, startedAt: Date.now() })
    try {
      const p = await monitor.cpuProfile(proc.id, ms)
      if (mounted.current) setSelectedId(p.id)
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setRecording(null)
    }
  }

  return (
    <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
      <div className="flex flex-col gap-3">
        {RECORDINGS.map((ms) => (
          <Button key={ms} variant={ms === RECORDINGS[0] ? "default" : "outline"} disabled={!running || !proc.profiling || !!recording} onClick={() => void record(ms)}>
            <CircleDotIcon data-icon="inline-start" />
            Record {ms / 1000}s
          </Button>
        ))}
        {recording && (
          <div role="status" className="rounded-2xl bg-secondary px-3.5 py-3 text-xs">
            <p className="font-semibold tabular-nums">
              Recording… {formatMs(Math.min(elapsed, recording.ms))} of {formatMs(recording.ms)}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
              <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, (elapsed / recording.ms) * 100)}%` }} />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-2xl bg-danger/10 px-3.5 py-3 text-xs text-danger">
            Couldn't record: {error}
          </p>
        )}
        {!running && <p className="px-1 text-xs text-muted-foreground">This run has ended, so nothing new can be recorded.</p>}
        {running && !proc.profiling && <p className="px-1 text-xs text-muted-foreground">No profiling agent is connected to this process.</p>}
        <div className="mt-2 text-xs font-semibold text-muted-foreground">
          Profiles <span className="text-faint">{profiles.length}</span>
        </div>
        <ul className="flex flex-col gap-1">
          {[...profiles].reverse().map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelectedId(p.id)}
                className={cn("w-full rounded-2xl px-3.5 py-2.5 text-left", p.id === profile?.id ? "bg-secondary" : "hover:bg-secondary/60")}
              >
                <span className="flex items-center justify-between text-sm font-semibold">
                  Profile {profiles.indexOf(p) + 1}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatMs(p.durationMs)}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                  T+{formatOffset(p.t - proc.startedAt)} · {formatClock(p.t)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {profiles.length === 0 && <p className="px-1 text-xs text-muted-foreground">No CPU profiles yet.</p>}
      </div>
      {profile ? (
        <Card title="CPU profile." subtitle={`${formatMs(profile.durationMs)} recorded. ${SAMPLING_NOTE[profile.sampling ?? "unknown"]}`}>
          <FlameGraph key={profile.id} root={profile.root} format={formatMs} hint="Width = sampled time beneath a frame. Stronger shade = more samples in the frame itself. Click to zoom." />
        </Card>
      ) : (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-card bg-secondary text-center">
          <h2 className="text-title">No profile selected.</h2>
          <p className="mt-2 text-sm text-muted-foreground">Record a few seconds to see where the time goes.</p>
        </div>
      )}
    </div>
  )
}

function HeapProfiler({ proc }: { proc: Proc }) {
  const snaps = proc.snapshots
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const index = Math.max(0, selectedId ? snaps.findIndex((s) => s.id === selectedId) : snaps.length - 1)
  const snap = snaps[index]
  const base = index > 0 ? snaps[index - 1] : undefined
  const rows = useMemo(() => (snap ? diffSnapshots(snap, base) : []), [snap, base])
  const grower = snap ? topGrower(rows, snap.heapUsed) : null
  const running = proc.status === "running"

  const take = async () => {
    setBusy(true)
    try {
      const s = await monitor.takeSnapshot(proc.id)
      if (s) setSelectedId(s.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
      <div className="flex flex-col gap-3">
        <Button onClick={take} disabled={!running || !proc.profiling || busy}>
          <CameraIcon data-icon="inline-start" />
          {busy ? "Capturing…" : "Take snapshot"}
        </Button>
        <Button variant="outline" onClick={() => monitor.forceGc(proc.id)} disabled={!running || !proc.profiling || !proc.hasGc}>
          <RecycleIcon data-icon="inline-start" />
          Collect garbage
        </Button>
        <div className="mt-2 text-xs font-semibold text-muted-foreground">
          Snapshots <span className="text-faint">{snaps.length}</span>
        </div>
        <ul className="flex flex-col gap-1">
          <AnimatePresence initial={false}>
            {[...snaps].reverse().map((s) => {
              const i = snaps.indexOf(s)
              const prev = snaps[i - 1]
              const d = prev ? s.heapUsed - prev.heapUsed : 0
              const active = s.id === snap?.id
              return (
                <motion.li key={s.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <button
                    onClick={() => setSelectedId(s.id)}
                    className={cn(
                      "relative w-full rounded-2xl px-3.5 py-2.5 text-left",
                      active ? "bg-secondary" : "hover:bg-secondary/60",
                    )}
                  >
                    <span className="flex items-center justify-between text-sm font-semibold">
                      Snapshot {i + 1}
                      <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatBytes(s.heapUsed)}</span>
                    </span>
                    <span className="mt-0.5 flex justify-between text-xs text-muted-foreground tabular-nums">
                      <span>
                        T+{formatOffset(s.t - proc.startedAt)} · {formatClock(s.t)}
                      </span>
                      {prev && <span className={d > 0 ? "font-semibold text-warning" : "text-success"}>{d >= 0 ? "+" : "−"}{formatBytes(Math.abs(d))}</span>}
                    </span>
                  </button>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
        {snaps.length === 0 && <p className="px-1 text-xs text-muted-foreground">No snapshots yet.</p>}
      </div>

      {snap ? (
        <motion.div key={snap.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-3 gap-4">
            <Metric label="Heap used" value={<Bytes value={snap.heapUsed} />} hint={base ? `${snap.heapUsed >= base.heapUsed ? "+" : "−"}${formatBytes(Math.abs(snap.heapUsed - base.heapUsed))} vs snapshot ${index}` : "First snapshot"} />
            <Metric label="Objects" value={formatCount(rows.reduce((a, r) => a + r.count, 0))} hint={`${rows.length} types`} />
            {grower ? (
              <div className="rounded-card bg-danger/10 p-5 ring-1 ring-danger/25 ring-inset">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-danger">
                  <span className="size-2 rounded-full bg-danger" /> Likely leak
                </p>
                <p className="mt-2 truncate font-mono text-[17px] font-semibold">{grower.name}</p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  +{formatCount(grower.deltaCount)} objects · +{formatBytes(grower.delta)} retained
                </p>
              </div>
            ) : (
              <Metric label="Growth" value={base ? "None notable" : "—"} hint={base ? "No type grew more than 3% of heap" : "Take another snapshot to compare"} />
            )}
          </div>

          <Card title="Heap by type." subtitle="Area = retained size. Stronger shade = grew more since the previous snapshot.">
            <HeapTreemap entries={rows} />
          </Card>

          <Card title="Allocation sites." subtitle="Sampled call stacks that allocated live memory.">
            <FlameGraph root={snap.sites} />
          </Card>

          <Card title="Types." subtitle={base ? `Compared with snapshot ${index}.` : "Take another snapshot to see what changed."}>
            <div className="-mx-6 -mb-6 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary hover:bg-secondary">
                    <TableHead className="pl-6 text-xs text-muted-foreground">Constructor</TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground">Objects</TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground">Shallow</TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground">Retained</TableHead>
                    <TableHead className="pr-6 text-right text-xs text-muted-foreground">Δ retained</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.name} className="hover:bg-secondary/50">
                      <TableCell className="pl-6 font-mono text-[12.5px]">
                        {r.name}
                        {r.isNew && <span className="ml-2 rounded-full bg-signal/12 px-1.5 py-px text-[10px] font-semibold text-signal">new</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(r.count)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(r.shallow)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(r.retained)}</TableCell>
                      <TableCell className={cn("pr-6 text-right tabular-nums", r.delta > 0 && (r === grower ? "font-semibold text-danger" : "text-warning"))}>
                        {base ? `${r.delta >= 0 ? "+" : "−"}${formatBytes(Math.abs(r.delta))}` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </motion.div>
      ) : (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-card bg-secondary text-center">
          <h2 className="text-title">No snapshot selected.</h2>
          <p className="mt-2 text-sm text-muted-foreground">Take a heap snapshot to see what is holding memory.</p>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-card border border-border p-5">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 text-heading tabular-nums">{value}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
