import { describe, expect, it } from "vitest"
import { hostAssessment, machineSeries } from "@/lib/machine"
import type { SystemSample } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const sys = (t: number, over: Partial<SystemSample> = {}): SystemSample => ({
  t, memTotal: 100, memAvailable: 60, swapTotal: 10, swapFree: 4, psiSome: 1, psiFull: 0.5, load1: 1, cpu: 10, ...over,
})

describe("machineSeries", () => {
  it("derives used figures and keeps the process a separate series", () => {
    const rows = machineSeries([sys(1000), sys(1500)], makeProc({ samples: [sample(1500, 9), sample(99_999, 5)] }))
    expect(rows[0]).toMatchObject({ memUsed: 40, swapUsed: 6 })
    expect(rows[0].procRss).toBeUndefined()
    expect(rows[1].procRss).toBe(9)
    expect(machineSeries([sys(1000)], null)[0].procRss).toBeUndefined()
    expect(machineSeries([], null)).toEqual([])
  })

  it("buckets long histories by maximum so spikes survive", () => {
    const many = Array.from({ length: 2000 }, (_, i) => sys(i * 500, i === 700 ? { cpu: 99, memAvailable: 1, load1: 9, swapFree: 0, psiSome: 50, psiFull: 40 } : {}))
    const rows = machineSeries(many, makeProc({ samples: [sample(0, 3), sample(10, 8)] }), 100)
    expect(rows.length).toBeLessThanOrEqual(101)
    const peak = rows.reduce((a, r) => (r.cpu > a.cpu ? r : a))
    expect(peak).toMatchObject({ cpu: 99, memUsed: 99, load1: 9, swapUsed: 10, psiSome: 50, psiFull: 40 })
    expect(rows[0].procRss).toBe(8)
  })

  it("keeps unreported pressure unknown when merging", () => {
    const rows = machineSeries([sys(1000, { psiSome: null, psiFull: null }), sys(1100, { psiSome: null, psiFull: null })], null)
    expect(rows).toHaveLength(1)
    expect(rows[0].psiSome).toBeNull()
    expect(rows[0].psiFull).toBeNull()
    const first = machineSeries([sys(1000, { psiSome: null, psiFull: null }), sys(1100)], null)
    expect(first[0].psiSome).toBe(1)
  })
})

describe("hostAssessment", () => {
  it("flags low memory or high pressure, whatever one process is doing", () => {
    expect(hostAssessment(sys(1)).starved).toBe(false)
    expect(hostAssessment(sys(1, { memAvailable: 5 })).starved).toBe(true)
    expect(hostAssessment(sys(1, { psiSome: 20 })).starved).toBe(true)
    expect(hostAssessment(sys(1, { psiSome: null })).starved).toBe(false)
    expect(hostAssessment(sys(1, { memTotal: 0, memAvailable: 0 })).starved, "no capacity data isn't starvation").toBe(false)
  })
})
