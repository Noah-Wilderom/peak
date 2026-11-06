import { describe, expect, it } from "vitest"
import { childMemorySeries, reported } from "@/lib/resources"
import { makeProc, sample } from "@/test/fixtures"

describe("childMemorySeries", () => {
  it("stacks the main process and children so the parts add up to the total", () => {
    const data = [sample(1, 100, { kids: [{ pid: 7, rss: 30, cpu: 0 }, { pid: 8, rss: 20, cpu: 0 }] })]
    const { series, rows, hasChildren } = childMemorySeries(makeProc({ childNames: { 7: "esbuild" } }), data)
    expect(hasChildren).toBe(true)
    expect(series.map((s) => s.label)).toEqual(["Main process", "esbuild (7)", "child (8)"])
    expect(rows).toEqual([{ t: 1, total: 100, root: 50, pid7: 30, pid8: 20 }])
  })

  it("merges small children into 'other' and never lets the main share go negative", () => {
    const kids = Array.from({ length: 8 }, (_, i) => ({ pid: i + 1, rss: 100 - i, cpu: 0 }))
    const { series, rows } = childMemorySeries(makeProc(), [sample(1, 10, { kids })])
    expect(series.at(-1)).toEqual({ key: "other", label: "2 other children" })
    expect(series).toHaveLength(8)
    expect(rows[0].other).toBe(94 + 93)
    expect(rows[0].root).toBe(0)
  })

  it("omits samples that recorded no breakdown instead of drawing zeros", () => {
    const out = childMemorySeries(makeProc(), [sample(1, 5), sample(2, 5, { kids: [] })])
    expect(out.hasChildren).toBe(false)
    expect(out.rows.map((r) => r.t)).toEqual([2])
  })
})

describe("reported", () => {
  it("tells a measured zero from a missing field", () => {
    expect(reported([sample(1, 1)], "threads")).toBe(false)
    expect(reported([sample(1, 1, { threads: 0 })], "threads")).toBe(true)
  })
})
