import type { Proc } from "@/lib/types"
import { formatBytes } from "@/lib/format"

export type MarkerKind = "stderr" | "gc" | "snapshot" | "alert"

export interface Marker {
  t: number
  kind: MarkerKind
  label: string
}

export const MARKER_STYLE: Record<MarkerKind, { name: string; color: string }> = {
  stderr: { name: "stderr", color: "var(--danger)" },
  gc: { name: "Major GC", color: "var(--faint)" },
  snapshot: { name: "Snapshot", color: "var(--signal)" },
  alert: { name: "Alert", color: "var(--warning)" },
}

/** Most markers per kind across the visible window; denser events are merged. */
const SLOTS = 80

/** Events within [from, to], thinned per kind so busy runs stay readable. */
export function timelineMarkers(proc: Proc, from: number, to: number): Marker[] {
  const inView = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= from && x.t <= to)
  const slotMs = Math.max(1, (to - from) / SLOTS)

  const thin = (kind: MarkerKind, events: { t: number; label: string }[], many: (n: number) => string) => {
    const slots = new Map<number, { t: number; label: string; n: number }>()
    for (const e of events) {
      const key = Math.floor((e.t - from) / slotMs)
      const slot = slots.get(key)
      if (slot) slot.n++
      else slots.set(key, { ...e, n: 1 })
    }
    return [...slots.values()].map((s): Marker => ({ t: s.t, kind, label: s.n > 1 ? many(s.n) : s.label }))
  }

  return [
    ...thin(
      "stderr",
      inView(proc.logs.filter((l) => l.stream === "stderr")).map((l) => ({ t: l.t, label: l.text })),
      (n) => `${n} stderr lines`,
    ),
    ...thin(
      "gc",
      inView(proc.gc.filter((g) => g.kind === "major")).map((g) => ({ t: g.t, label: `Major GC · ${g.pauseMs.toFixed(1)}ms pause` })),
      (n) => `${n} major GCs`,
    ),
    ...thin(
      "snapshot",
      inView(proc.snapshots).map((s) => ({ t: s.t, label: `Heap snapshot · ${formatBytes(s.heapUsed)}` })),
      (n) => `${n} heap snapshots`,
    ),
    ...thin(
      "alert",
      inView(proc.alerts ?? []).map((a) => ({ t: a.t, label: a.message })),
      (n) => `${n} alerts`,
    ),
  ]
}

/** The marker closest to `t` within `within` ms, if any. */
export function nearestMarker(markers: Marker[], t: number, within: number) {
  let best: Marker | null = null
  for (const m of markers) {
    if (Math.abs(m.t - t) <= within && (!best || Math.abs(m.t - t) < Math.abs(best.t - t))) best = m
  }
  return best
}
