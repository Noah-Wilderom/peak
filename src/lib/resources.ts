import type { Proc, Sample } from "@/lib/types"

export interface ChildSeries {
  key: string
  label: string
}

/** Most child processes drawn individually; the rest are summed as "other". */
const MAX_SERIES = 6

/**
 * Stacked memory by process: the root process's own share, its largest children,
 * and everything else. The stack's height is the tree's total RSS, so the parts
 * and the total stay distinguishable. Samples that recorded no breakdown are left
 * out rather than shown as an empty stack.
 */
export function childMemorySeries(proc: Proc, data: Sample[]) {
  const peaks = new Map<number, number>()
  for (const s of data) for (const k of s.kids ?? []) peaks.set(k.pid, Math.max(peaks.get(k.pid) ?? 0, k.rss))
  const ranked = [...peaks].sort((a, b) => b[1] - a[1]).map(([pid]) => pid)
  const top = new Set(ranked.slice(0, MAX_SERIES))
  const rest = ranked.length > MAX_SERIES

  const series: ChildSeries[] = [
    { key: "root", label: "Main process" },
    ...[...top].map((pid) => ({ key: `pid${pid}`, label: `${proc.childNames?.[pid] ?? "child"} (${pid})` })),
    ...(rest ? [{ key: "other", label: `${ranked.length - MAX_SERIES} other children` }] : []),
  ]

  const rows = data.filter((s) => s.kids).map((s) => {
    const row: Record<string, number> = { t: s.t, total: s.rss }
    let childTotal = 0
    for (const k of s.kids!) {
      childTotal += k.rss
      const key = top.has(k.pid) ? `pid${k.pid}` : "other"
      row[key] = (row[key] ?? 0) + k.rss
    }
    row.root = Math.max(0, s.rss - childTotal)
    return row
  })
  return { series, rows, hasChildren: ranked.length > 0 }
}

/** Whether any sample in the window reported this field at all. */
export function reported(data: Sample[], key: "threads" | "files" | "sockets" | "pipes" | "loopLag") {
  return data.some((s) => s[key] !== undefined)
}
