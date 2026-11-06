import { describe, expect, it } from "vitest"
import { alignRuns, bytesDelta, cpuDelta, durationDelta, runStats } from "@/lib/compare"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 * 1024

describe("alignRuns", () => {
  it("aligns on each run's own start, however far apart they ran", () => {
    const a = makeProc({ startedAt: 1000, samples: [sample(1000, 10), sample(1500, 20), sample(2000, 30)] })
    const b = makeProc({ startedAt: 9_000_000, samples: [sample(9_000_000, 5), sample(9_000_500, 6)] })
    expect(alignRuns(a, b)).toEqual([
      { offset: 0, a: 10, b: 5 },
      { offset: 500, a: 20, b: 6 },
      { offset: 1000, a: 30 },
    ])
  })

  it("leaves a gap, never a zero, after the shorter run ends", () => {
    const a = makeProc({ startedAt: 0, samples: [sample(0, 1), sample(500, 1)] })
    const b = makeProc({ startedAt: 0, samples: [sample(0, 2), sample(500, 2), sample(1000, 2)] })
    const last = alignRuns(a, b).at(-1)!
    expect(last.a).toBeUndefined()
    expect(last.b).toBe(2)
  })

  it("buckets long runs by maximum so spikes survive", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => sample(i * 500, i === 500 ? 999 : 1))
    const out = alignRuns(makeProc({ startedAt: 0, samples }), makeProc({ startedAt: 0, samples: [sample(0, 1)] }), 100)
    expect(out.length).toBeLessThanOrEqual(101)
    expect(Math.max(...out.map((p) => p.a ?? 0))).toBe(999)
  })

  it("keeps samples from before the recorded start in the first bucket", () => {
    const out = alignRuns(makeProc({ startedAt: 1000, samples: [sample(900, 7)] }), makeProc({ startedAt: 0, samples: [sample(0, 1)] }))
    expect(out[0]).toEqual({ offset: 0, a: 7, b: 1 })
  })
})

describe("runStats", () => {
  it("summarizes a finished run", () => {
    const p = makeProc({ startedAt: 1000, endedAt: 4000, samples: [sample(1000, 100, { cpu: 10 }), sample(1500, 200, { cpu: 30 })] })
    expect(runStats(p)).toEqual({ peakRss: 200, durationMs: 3000, avgCpu: 20, hasData: true, firstSampleAt: 0 })
  })

  it("is honest about running, empty and late-started runs", () => {
    expect(runStats(makeProc()).durationMs).toBeNull()
    expect(runStats(makeProc({ samples: [sample(1000, 0)] })).hasData).toBe(false)
    expect(runStats(makeProc({ samples: [sample(1000, 5)] })).hasData).toBe(true)
    expect(runStats(makeProc({ startedAt: 1000, samples: [sample(61_000, 5)] })).firstSampleAt).toBe(60_000)
  })
})

describe("deltas", () => {
  it("reads from run A to run B, with units", () => {
    expect(bytesDelta(100 * MiB, 110 * MiB)).toBe("+10 MiB (+10.0%)")
    expect(bytesDelta(100 * MiB, 50 * MiB)).toBe("−50 MiB (−50.0%)")
    expect(bytesDelta(0, 5 * MiB), "no percentage of nothing").toBe("+5 MiB")
    expect(durationDelta(60_000, 90_000)).toBe("+30s")
    expect(durationDelta(90_000, 60_000)).toBe("−30s")
    expect(durationDelta(null, 1), "a running run has no length yet").toBe("—")
    expect(durationDelta(1, null)).toBe("—")
    expect(cpuDelta(10, 12.5)).toBe("+2.5 pts")
    expect(cpuDelta(10, 7)).toBe("−3.0 pts")
  })
})
