import type { RunSummary } from "@/lib/types"

export interface RunGroup {
  command: string
  runs: RunSummary[]
}

/** Group runs by command, most recently run command first (input is newest first). */
export function groupRuns(runs: RunSummary[]): RunGroup[] {
  const groups = new Map<string, RunSummary[]>()
  for (const run of runs) {
    const group = groups.get(run.command)
    if (group) group.push(run)
    else groups.set(run.command, [run])
  }
  return [...groups].map(([command, runs]) => ({ command, runs }))
}

/** How a stored run ended, in words. Runs cut off by peak closing are not claimed as exits. */
export function runOutcome(run: Pick<RunSummary, "status" | "exitCode" | "signal">) {
  if (run.status === "running") return "Running"
  if (run.signal === "peak closed") return "Interrupted"
  if (run.signal === "ended while disconnected") return "Ended while disconnected"
  if (run.signal === "target rebooted") return "Target rebooted"
  if (run.signal === "monitoring stopped") return "Monitoring stopped"
  if (run.signal === "stopped with the session") return "Stopped with the session"
  if (run.status === "crashed") return run.signal ? `Killed · ${run.signal}` : `Failed · exit ${run.exitCode}`
  if (run.signal) return `Stopped · ${run.signal}`
  return run.exitCode == null ? "Ended" : `Exited · ${run.exitCode}`
}

/** Toggle `id` in a selection limited to `max`; beyond the limit the selection is unchanged. */
export function toggleSelection(selected: string[], id: string, max = 2) {
  if (selected.includes(id)) return selected.filter((x) => x !== id)
  return selected.length < max ? [...selected, id] : selected
}
