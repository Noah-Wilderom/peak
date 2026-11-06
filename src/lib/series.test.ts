import { describe, expect, it } from "vitest"
import { TICK_MS, type Proc, type Sample } from "@/lib/types"
import { sample } from "@/test/fixtures"
import {
  average,
  bucketMsFor,
  byteUnit,
  histogram,
  MIN_TREND_SAMPLES,
  maxOf,
  niceTicks,
  percentiles,
  RANGES,
  rangeMs,
  stddev,
  timeStep,
  timeTicks,
  trend,
  valueAgo,
  viewData,
  visibleSamples,
} from "@/lib/series"

const proc = (samples: Sample[]) => ({ samples, startedAt: samples[0].t }) as Proc

describe("series", () => {
  const samples = Array.from({ length: 200 }, (_, i) => sample(i * 500, 1000 + i))

  it("computes range spans", () => {
    expect(rangeMs(proc(samples), { kind: "live", range: "30s" })).toBe(30_000)
    expect(rangeMs(proc(samples), { kind: "live", range: "all" })).toBe(99_500)
    expect(rangeMs(proc(samples.slice(0, 3)), { kind: "live", range: "all" })).toBe(30_000)
    expect(rangeMs(proc(samples), { kind: "fixed", from: 10, to: 110 })).toBe(100)
    expect(bucketMsFor(30_000)).toBe(500)
    expect(bucketMsFor(3_600_000)).toBe(15_000)
  })

  it("buckets by absolute time keeping per-field maxima", () => {
    const s = [
      sample(0, 10, { cpu: 50, cpuUser: 40, cpuSys: 10 }),
      sample(100, 30, { cpu: 5, read: 9, write: 9, alloc: 9, faults: 9 }),
      sample(200, 20, { cpu: 70, cpuUser: 60, cpuSys: 10 }),
      sample(600, 5),
    ]
    const { data, bucketMs } = viewData(proc(s), { kind: "fixed", from: 0, to: 600 })
    expect(bucketMs).toBe(500)
    expect(data).toHaveLength(2)
    expect(data[0].rss).toBe(30)
    expect(data[0].heap).toBe(15) // composition follows the max-RSS sample
    expect(data[0].cpu).toBe(70)
    expect(data[0].cpuUser).toBe(60)
    expect(data[0].read).toBe(9)
    expect(data[0].t).toBe(200)
    expect(data[1].rss).toBe(5)
    // Live views include a little overflow before the window.
    const live = viewData(proc(samples), { kind: "live", range: "30s" }).data
    expect(live[0].t).toBeLessThan(samples.at(-1)!.t - 30_000)
    expect(viewData(proc(samples), { kind: "fixed", from: 1e9, to: 2e9 }).data).toEqual([])
  })

  it("returns raw samples inside the window", () => {
    expect(visibleSamples(proc(samples), { kind: "fixed", from: 1000, to: 2000 }).map((s) => s.t)).toEqual([1000, 1500, 2000])
    expect(visibleSamples(proc(samples), { kind: "live", range: "30s" })).toHaveLength(61)
  })

  it("aligns time ticks", () => {
    expect(timeTicks(1_000, 31_000, "elapsed", 1_000)).toEqual([1_000, 6_000, 11_000, 16_000, 21_000, 26_000, 31_000])
    expect(timeTicks(1_500, 61_500, "clock", 0)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000])
    expect(timeTicks(0, 1e9, "clock", 0).length).toBeGreaterThan(0)
  })

  it("offers the short windows ahead of every earlier range", () => {
    expect(RANGES.map((r) => [r.label, r.ms])).toEqual([
      ["1s", 1_000],
      ["10s", 10_000],
      ["30s", 30_000],
      ["1m", 60_000],
      ["5m", 300_000],
      ["15m", 900_000],
      ["1h", 3_600_000],
      ["All", Infinity],
    ])
  })

  describe.each([
    { range: "1s", ms: 1_000, inWindow: [98_500, 99_000, 99_500] },
    { range: "10s", ms: 10_000, inWindow: Array.from({ length: 21 }, (_, i) => 89_500 + i * 500) },
  ] as const)("the $range window", ({ range, ms, inWindow }) => {
    const view = { kind: "live", range } as const

    it("spans exactly its duration and shows every recorded sample, unmerged", () => {
      expect(rangeMs(proc(samples), view)).toBe(ms)
      expect(bucketMsFor(ms)).toBe(TICK_MS)
      expect(visibleSamples(proc(samples), view).map((s) => s.t)).toEqual(inWindow)
      const { data, span } = viewData(proc(samples), view)
      expect(span).toBe(ms)
      expect(data.map((s) => s.t)).toEqual(expect.arrayContaining([...inWindow]))
      expect(data.find((s) => s.t === 99_500)!.rss).toBe(1199)
      // Enough overflow for the line to leave the left edge while gliding.
      expect(data[0].t).toBeLessThan(inWindow[0] - TICK_MS * 1.5)
    })

    it("holds the whole run when the run is shorter than the window", () => {
      const short = samples.slice(0, 2)
      expect(visibleSamples(proc(short), view).map((s) => s.t)).toEqual(short.map((s) => s.t))
      expect(viewData(proc(short), view).data.map((s) => s.t)).toEqual(short.map((s) => s.t))
    })
  })

  it("keeps a real sample beyond each edge when samples are further apart than the window", () => {
    const sparse = [sample(0, 10), sample(5_000, 20), sample(10_000, 30), sample(15_000, 40)]
    // Stored run, ending at its last sample: the line still reaches the left edge.
    expect(viewData(proc(sparse), { kind: "live", range: "1s" }).data.map((s) => s.t)).toEqual([10_000, 15_000])
    expect(viewData(proc(sparse), { kind: "live", range: "10s" }).data.map((s) => s.t)).toEqual([0, 5_000, 10_000, 15_000])
    // A zoom between two samples is crossed by the line through them, nothing invented.
    const zoom = viewData(proc(sparse), { kind: "fixed", from: 6_500, to: 7_500 }).data
    expect(zoom.map((s) => [s.t, s.rss])).toEqual([[5_000, 20], [10_000, 30]])
    // Past either end of the data there is nothing to run through.
    expect(viewData(proc(sparse), { kind: "fixed", from: -60_000, to: -50_000 }).data).toEqual([])
  })

  it("steps ticks below a second only for windows that need it", () => {
    expect(timeStep(1_000)).toBe(200)
    expect(timeStep(500)).toBe(100)
    expect(timeStep(2_500)).toBe(500)
    expect(timeStep(6_000)).toBe(1_000)
    expect(timeStep(10_000)).toBe(2_000)
    expect(timeStep(30_000)).toBe(5_000)
    expect(timeTicks(10_050, 11_050, "elapsed", 50)).toEqual([10_050, 10_250, 10_450, 10_650, 10_850, 11_050])
    expect(timeTicks(10_050, 11_050, "clock", 0)).toEqual([10_200, 10_400, 10_600, 10_800, 11_000])
    expect(timeTicks(1_000, 11_000, "elapsed", 1_000)).toEqual([1_000, 3_000, 5_000, 7_000, 9_000, 11_000])
    // Scrolling never re-spaces them: the same instants stay ticks as the window moves.
    expect(timeTicks(10_123, 11_123, "clock", 0)).toEqual([10_200, 10_400, 10_600, 10_800, 11_000])
  })

  it("needs enough samples for a trend", () => {
    const rising = (n: number) => Array.from({ length: n }, (_, i) => sample(i * 500, 1000 + i * 100))
    expect(trend(rising(MIN_TREND_SAMPLES - 1), "rss").slope).toBe(0)
    expect(trend(rising(MIN_TREND_SAMPLES), "rss").slope).toBeGreaterThan(0)
  })

  it("builds nice value ticks", () => {
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100])
    expect(niceTicks(380, 4)).toEqual([0, 100, 200, 300, 400])
    expect(niceTicks(0)[0]).toBe(0)
    expect(niceTicks(3 * 1024 ** 2, 3, 1024 ** 2)).toEqual([0, 1024 ** 2, 2 * 1024 ** 2, 3 * 1024 ** 2])
    expect(niceTicks(1000, 1)).toEqual([0, 1000])
    expect(byteUnit(500)).toBe(1024)
    expect(byteUnit(5 * 1024 ** 2)).toBe(1024 ** 2)
    expect(byteUnit(5 * 1024 ** 3)).toBe(1024 ** 3)
  })

  it("computes statistics", () => {
    const s = [sample(0, 10), sample(1000, 20), sample(2000, 30)]
    expect(average(s, "rss")).toBe(20)
    expect(average([], "rss")).toBe(0)
    expect(maxOf(s, "rss")).toBe(30)
    expect(maxOf([...s].reverse(), "rss")).toBe(30)
    expect(valueAgo(s, "rss", 1000)).toBe(20)
    expect(valueAgo(s, "rss", 5000)).toBe(10)
    expect(valueAgo([], "rss", 1)).toBe(0)
    expect(percentiles([5, 1, 3, 2, 4], [0, 50, 100])).toEqual([1, 3, 5])
    expect(percentiles([], [50, 99])).toEqual([0, 0])
    expect(stddev([1])).toBe(0)
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3)
    expect(histogram([0, 1, 9, 10], 2, 10).map((b) => b.count)).toEqual([2, 2])
  })

  it("fits trends", () => {
    const line = Array.from({ length: 20 }, (_, i) => sample(i * 1000, 100 + i * 10))
    const t = trend(line, "rss")
    expect(t.slope).toBeCloseTo(0.01)
    expect(t.r2).toBeCloseTo(1)
    expect(trend(line.slice(0, 5), "rss")).toEqual({ slope: 0, r2: 0 })
    const flat = Array.from({ length: 20 }, () => sample(0, 1))
    expect(trend(flat, "rss")).toEqual({ slope: 0, r2: 0 })
    const constant = Array.from({ length: 20 }, (_, i) => sample(i, 5))
    expect(trend(constant, "rss")).toEqual({ slope: 0, r2: 0 })
  })
})

describe("viewData optional fields", () => {
  const at = (t: number, rss: number, extra = {}) => ({ t, rss, heap: 0, heapTotal: 0, external: 0, code: 0, stack: 0, cpu: 0, cpuUser: 0, cpuSys: 0, read: 0, write: 0, alloc: 0, faults: 0, ...extra })
  const base = { id: "p", startedAt: 0 } as never as Proc

  it("buckets lag and resource counts, keeping absent fields absent", () => {
    const samples = Array.from({ length: 400 }, (_, i) => at(i * 500, i === 1 ? 9 : 1, i === 0 ? { threads: 7, kids: [] } : i === 1 ? { loopLag: 40, threads: 3, kids: [{ pid: 1, rss: 2, cpu: 0 }] } : i === 2 ? { loopLag: 50 } : i === 3 ? { loopLag: 5 } : {}))
    const first = viewData({ ...base, samples }, { kind: "live", range: "all" }).data[0]
    expect(first.loopLag).toBe(40)
    expect(first.kids).toEqual([{ pid: 1, rss: 2, cpu: 0 }])
    expect(viewData({ ...base, samples }, { kind: "live", range: "all" }).data[1].loopLag, "the worst in the bucket").toBe(50)
    const none = viewData({ ...base, samples: samples.map((s) => at(s.t, s.rss)) }, { kind: "live", range: "all" }).data[0]
    expect("loopLag" in none).toBe(false)
    expect(none.threads).toBeUndefined()
  })
})
