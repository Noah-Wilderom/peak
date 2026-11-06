import type { Proc, SystemSample } from "@/lib/types"
import { TICK_MS } from "@/lib/types"

export interface MachinePoint extends SystemSample {
  memUsed: number
  swapUsed: number
  /** The selected process's memory at this moment, when it was being sampled. */
  procRss?: number
}

/**
 * Machine samples bucketed for charting (per-bucket maxima, so spikes survive),
 * with the selected process's RSS alongside. Process and host stay separate series.
 */
export function machineSeries(samples: SystemSample[], proc: Proc | null, points = 300): MachinePoint[] {
  const span = samples.length ? samples.at(-1)!.t - samples[0].t : 0
  const bucket = Math.max(TICK_MS, Math.ceil(span / points / TICK_MS) * TICK_MS)
  const rows = new Map<number, MachinePoint>()
  for (const s of samples) {
    const key = Math.floor(s.t / bucket)
    const point: MachinePoint = { ...s, memUsed: s.memTotal - s.memAvailable, swapUsed: s.swapTotal - s.swapFree }
    const prev = rows.get(key)
    rows.set(key, !prev ? point : {
      ...point,
      memUsed: Math.max(prev.memUsed, point.memUsed),
      swapUsed: Math.max(prev.swapUsed, point.swapUsed),
      cpu: Math.max(prev.cpu, point.cpu),
      load1: Math.max(prev.load1, point.load1),
      psiSome: point.psiSome === null ? null : Math.max(prev.psiSome ?? 0, point.psiSome),
      psiFull: point.psiFull === null ? null : Math.max(prev.psiFull ?? 0, point.psiFull),
    })
  }
  if (proc) {
    for (const s of proc.samples) {
      const row = rows.get(Math.floor(s.t / bucket))
      if (row) row.procRss = Math.max(row.procRss ?? 0, s.rss)
    }
  }
  return [...rows.values()]
}

/** Is the host itself under pressure? Separate from how big any one process is. */
export function hostAssessment(s: SystemSample) {
  const free = s.memTotal > 0 ? s.memAvailable / s.memTotal : 1
  if (free < 0.1 || (s.psiSome ?? 0) > 10) {
    return { starved: true, title: "The machine is short on memory.", detail: "Slowdowns may come from the host, not just this process." }
  }
  return { starved: false, title: "The machine has room.", detail: "Memory growth you see is the process's own, not the host running out." }
}
