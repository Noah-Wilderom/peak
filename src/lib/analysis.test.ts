import { describe, expect, it } from "vitest"
import { analyzeTrend, composition, diffSnapshots, gcStats, topGrower } from "@/lib/analysis"
import type { HeapSnapshot } from "@/lib/types"
import { sample } from "@/test/fixtures"

const MB = 1024 * 1024
const snap = (entries: [string, number, number][], heapUsed = 100 * MB): HeapSnapshot => ({
  id: "s",
  t: 0,
  heapUsed,
  entries: entries.map(([name, count, retained]) => ({ name, count, shallow: retained, retained })),
  sites: { name: "(root)", self: 0, children: [] },
})

describe("analysis", () => {
  it("splits memory into non-negative parts", () => {
    const s = sample(0, 100, { heap: 40, heapTotal: 50, external: 10, code: 5, stack: 5 })
    expect(composition(s)).toEqual({ heapUsed: 40, heapFree: 10, external: 10, native: 30, codeStack: 10 })
    const tight = sample(0, 10, { heap: 20, heapTotal: 10, external: 10, code: 5, stack: 5 })
    expect(composition(tight).heapFree).toBe(0)
    expect(composition(tight).native).toBe(0)
  })

  it("classifies trends", () => {
    const growing = Array.from({ length: 60 }, (_, i) => sample(i * 1000, 100 * MB + i * 2 * MB))
    const g = analyzeTrend(growing, 1024 * MB)
    expect(g.verdict).toBe("growing")
    expect(g.perMin).toBeCloseTo(120 * MB, -3)
    expect(g.toLimit).toBeGreaterThan(0)
    const shrinking = [...growing].map((s, i) => ({ ...s, rss: 300 * MB - i * 2 * MB }))
    expect(analyzeTrend(shrinking).verdict).toBe("shrinking")
    const saw = Array.from({ length: 60 }, (_, i) => sample(i * 1000, (i % 10 < 5 ? 100 : 200) * MB))
    expect(analyzeTrend(saw).verdict).toBe("oscillating")
    const flat = Array.from({ length: 60 }, (_, i) => sample(i * 1000, 100 * MB))
    const f = analyzeTrend(flat)
    expect(f.verdict).toBe("stable")
    expect(f.toLimit).toBe(Infinity)
    expect(analyzeTrend([]).cv).toBe(0)
    // Already past the limit: zero time left, never negative.
    expect(analyzeTrend(growing, 1).toLimit).toBe(0)
  })

  it("summarizes GC within a window", () => {
    const gc = [
      { t: 10, kind: "minor" as const, pauseMs: 1, freed: 10 },
      { t: 20, kind: "major" as const, pauseMs: 9, freed: 90 },
      { t: 99, kind: "minor" as const, pauseMs: 100, freed: 1 },
    ]
    const s = gcStats({ gc }, 0, 50)
    expect(s).toMatchObject({ count: 2, major: 1, total: 10, max: 9, freed: 100, overhead: 0.2 })
    expect(gcStats({ gc }, 50, 50).overhead).toBe(0)
    expect(gcStats({ gc: [] }, 0, 1)).toMatchObject({ count: 0, max: 0, p50: 0 })
  })

  it("diffs snapshots and finds the grower", () => {
    const base = snap([["Map", 10, 5 * MB], ["Gone", 1, MB]])
    const cur = snap([["Map", 15, 6 * MB], ["CacheEntry", 1000, 40 * MB]])
    const rows = diffSnapshots(cur, base)
    expect(rows.map((r) => r.name)).toEqual(["CacheEntry", "Map"])
    expect(rows[0]).toMatchObject({ delta: 40 * MB, deltaCount: 1000, isNew: true })
    expect(rows[1]).toMatchObject({ delta: MB, deltaCount: 5, isNew: false })
    expect(topGrower(rows, cur.heapUsed)?.name).toBe("CacheEntry")
    expect(topGrower(rows.slice(1), cur.heapUsed)).toBeNull()
    expect(topGrower([], 1)).toBeNull()
    const first = diffSnapshots(cur)
    expect(first.every((r) => r.delta === 0 && !r.isNew)).toBe(true)
  })
})
