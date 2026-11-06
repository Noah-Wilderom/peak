import { describe, expect, it, vi } from "vitest"
import { AlertEngine, applyAlerts } from "@/lib/alerts"
import { DEFAULT_SETTINGS, type Proc, type Sample, type Settings } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 * 1024
const engine = (over: Partial<Settings>) => {
  const e = new AlertEngine()
  e.configure({ ...DEFAULT_SETTINGS, ...over })
  return e
}
/** Feed samples one tick at a time and collect what fires. */
function feed(e: AlertEngine, samples: Sample[], over: Partial<Proc> = {}) {
  const fired = []
  for (let i = 1; i <= samples.length; i++) fired.push(...e.check(makeProc({ samples: samples.slice(0, i), ...over })))
  return fired
}
const rss = (t: number, mib: number) => sample(t, mib * MiB, { cpu: 0 })
const cpu = (t: number, pct: number) => sample(t, MiB, { cpu: pct })

describe("memory alerts", () => {
  it("fires once per crossing and re-arms only after falling well below", () => {
    const fired = feed(engine({ alertMemoryMib: 100 }), [
      rss(1000, 50), rss(1500, 120), rss(2000, 130), rss(2500, 95), rss(3000, 120), rss(3500, 80), rss(4000, 101),
    ])
    expect(fired.map((a) => a.t)).toEqual([1500, 4000])
    expect(fired[0]).toMatchObject({ kind: "memory", value: 120 * MiB, threshold: 100 * MiB })
    expect(fired[0].message).toBe("Memory reached 120 MiB (limit 100 MiB)")
  })

  it("is off at 0", () => {
    expect(feed(engine({ alertMemoryMib: 0 }), [rss(1000, 9999)])).toEqual([])
  })
})

describe("sustained CPU alerts", () => {
  const e = () => engine({ alertCpuPercent: 90, alertCpuSeconds: 2 })

  it("waits out the full duration", () => {
    const fired = feed(e(), [cpu(1000, 95), cpu(1500, 95), cpu(2000, 95), cpu(2500, 95), cpu(3000, 95), cpu(3500, 95)])
    expect(fired.map((a) => a.t)).toEqual([3000])
    expect(fired[0].message).toBe("CPU above 90.0% for 2s (now 95.0%)")
  })

  it("restarts the clock on a dip, and can fire again after one", () => {
    expect(feed(e(), [cpu(1000, 95), cpu(2000, 95), cpu(2500, 10), cpu(3000, 95), cpu(4000, 95)])).toEqual([])
    const fired = feed(e(), [cpu(1000, 95), cpu(3000, 95), cpu(3500, 95), cpu(4000, 10), cpu(4500, 95), cpu(6500, 95)])
    expect(fired.map((a) => a.t)).toEqual([3000, 6500])
  })

  it("doesn't count a gap in sampling as sustained", () => {
    expect(feed(e(), [cpu(1000, 95), cpu(60_000, 95)])).toEqual([])
    expect(feed(e(), [cpu(1000, 95), cpu(60_000, 95), cpu(62_000, 95)]).map((a) => a.t)).toEqual([62_000])
  })

  it("is off when either limit is 0", () => {
    const samples = [cpu(1000, 500), cpu(90_000, 500)]
    expect(feed(engine({ alertCpuPercent: 0, alertCpuSeconds: 1 }), samples)).toEqual([])
    expect(feed(engine({ alertCpuPercent: 50, alertCpuSeconds: 0 }), samples)).toEqual([])
  })
})

describe("engine behaviour", () => {
  it("judges only new samples, never backfilling a run it first sees", () => {
    const e = engine({ alertMemoryMib: 100 })
    const history = [rss(1000, 500), rss(1500, 10)]
    expect(e.check(makeProc({ samples: history })), "the old spike isn't news").toEqual([])
    expect(e.check(makeProc({ samples: history })), "nothing new").toEqual([])
    expect(e.check(makeProc({ samples: [...history, rss(2000, 200)] }))).toHaveLength(1)
  })

  it("doesn't repeat alerts a reloaded run already carries for the same limit", () => {
    const already = { t: 1, kind: "memory" as const, message: "", value: 0, threshold: 100 * MiB }
    const busy = { t: 1, kind: "cpu" as const, message: "", value: 0, threshold: 90 }
    const samples = [sample(1000, 200 * MiB, { cpu: 95 })]
    const e = engine({ alertMemoryMib: 100, alertCpuPercent: 90, alertCpuSeconds: 0.001 })
    expect(e.check(makeProc({ samples, alerts: [already, busy] }))).toEqual([])
    const lower = engine({ alertMemoryMib: 50 })
    expect(lower.check(makeProc({ samples, alerts: [already] })), "a new limit is a new crossing").toHaveLength(1)
  })

  it("does nothing when disabled or for ended runs, and starts over when reconfigured", () => {
    const off = engine({ alertsEnabled: false, alertMemoryMib: 1 })
    expect(off.check(makeProc({ samples: [rss(1000, 10)] }))).toEqual([])
    const e = engine({ alertMemoryMib: 1 })
    expect(e.check(makeProc({ status: "exited", samples: [rss(1000, 10)] }))).toEqual([])
    expect(e.notifications).toBe(true)
    const samples = [rss(1000, 10)]
    expect(e.check(makeProc({ samples }))).toHaveLength(1)
    expect(e.check(makeProc({ samples }))).toHaveLength(0)
    e.configure({ ...DEFAULT_SETTINGS, alertMemoryMib: 1, notifications: false })
    expect(e.notifications).toBe(false)
    expect(e.check(makeProc({ samples: [rss(1000, 10)] })), "fresh limits judge the latest sample").toHaveLength(1)
  })
})

describe("applyAlerts", () => {
  it("attaches new alerts and leaves quiet processes untouched", () => {
    const e = engine({ alertMemoryMib: 100 })
    const quiet = makeProc({ id: "q", samples: [rss(1000, 1)] })
    const hot = makeProc({ id: "h", samples: [rss(1000, 200)], alerts: [{ t: 0, kind: "cpu", message: "old", value: 0, threshold: 0 }] })
    const onAlert = vi.fn()
    const [q, h] = applyAlerts(e, [quiet, hot], onAlert)
    expect(q).toBe(quiet)
    expect(h.alerts).toHaveLength(2)
    expect(onAlert).toHaveBeenCalledWith(h, h.alerts![1])
    const first = applyAlerts(engine({ alertMemoryMib: 100 }), [makeProc({ samples: [rss(1000, 200)] })], onAlert)[0]
    expect(first.alerts).toHaveLength(1)
  })
})
