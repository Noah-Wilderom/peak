import { describe, expect, it } from "vitest"
import { buildReport, reportJson, reportMarkdown, topSites } from "@/lib/report"
import type { Alert, HeapSnapshot, Sample } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 * 1024
const steady = (n = 40, rss = 100 * MiB): Sample[] => Array.from({ length: n }, (_, i) => sample(1000 + i * 500, rss, { cpu: 20 }))
const growing = (n = 40): Sample[] => Array.from({ length: n }, (_, i) => sample(1000 + i * 500, (100 + i * 10) * MiB))
const snapshot: HeapSnapshot = {
  id: "s", t: 5000, heapUsed: 50 * MiB,
  entries: [{ name: "Leaky", count: 10, shallow: 1, retained: 40 * MiB }],
  sites: { name: "(root)", self: 0, children: [{ name: "alloc", file: "a.js:1", self: 30 * MiB, children: [{ name: "inner", self: 5 * MiB, children: [] }] }] },
}
const alert: Alert = { t: 3000, kind: "memory", message: "Memory above 100 MiB", value: 2, threshold: 1 }

describe("buildReport", () => {
  it("summarizes a clean run with everything available", () => {
    const samples = steady()
    const r = buildReport(makeProc({
      samples, peak: samples[3], status: "exited", exitCode: 0, endedAt: 21_000,
      gc: [{ t: 2000, kind: "major", pauseMs: 100, freed: 1 }, { t: 3000, kind: "minor", pauseMs: 100, freed: 1 }],
      snapshots: [{ ...snapshot, id: "older", heapUsed: 1 }, snapshot],
    }))
    expect(r.state).toBe("finished")
    expect(r.verdict.title).toBe("Finished.")
    expect(r.verdict.detail).toMatch(/Memory trend: stable/)
    expect(r.outcome).toBe("Exited · 0")
    expect(r.durationMs).toBe(20_000)
    expect(r.memory.peakAtMs).toBe(1500)
    expect(r.avgCpu).toBe(20)
    expect(r.gc).toEqual({ collections: 2, major: 1, totalPauseMs: 200, sharePercent: 1 })
    expect(r.allocators!.heapUsed, "uses the latest snapshot").toBe(50 * MiB)
    expect(r.allocators!.types[0].name).toBe("Leaky")
    expect(r.allocators!.sites.map((s) => [s.name, s.file])).toEqual([["alloc", "a.js:1"], ["inner", null]])
    expect(r.alerts).toEqual([])
  })

  it("calls out leak-shaped growth, and notes a still-running run", () => {
    const samples = growing()
    const running = buildReport(makeProc({ samples, peak: samples.at(-1)! }))
    expect(running.state).toBe("running")
    expect(running.verdict.title).toBe("Memory is growing.")
    expect(running.verdict.detail).toMatch(/Still running/)
    expect(running.memory.trend!.bytesPerMin).toBeGreaterThan(0)
    expect(running.endedAt).toBeNull()
    expect(buildReport(makeProc({ samples: steady() })).verdict.title).toBe("Running.")
    expect(buildReport(makeProc({ samples: growing(), status: "exited", exitCode: 0 })).verdict.detail).toMatch(/Finished cleanly/)
  })

  it("names failures and interruptions instead of inventing outcomes", () => {
    const failed = buildReport(makeProc({ status: "crashed", signal: "SIGKILL", alerts: [alert] }))
    expect(failed.state).toBe("failed")
    expect(failed.verdict.detail).toMatch(/Killed · SIGKILL/)
    expect(failed.verdict.detail).toMatch(/1 alert fired/)
    const interrupted = buildReport(makeProc({ status: "exited", signal: "peak closed", alerts: [alert, alert] }))
    expect(interrupted.state).toBe("interrupted")
    expect(interrupted.outcome).toBe("Interrupted")
    expect(interrupted.verdict.detail).toMatch(/unknown/)
    expect(interrupted.verdict.detail).toMatch(/2 alerts fired/)
  })

  it("reports missing data as missing", () => {
    const r = buildReport(makeProc({ samples: [sample(1000, 5)], gc: [], snapshots: [] }))
    expect(r.gc).toBeNull()
    expect(r.gcNote).toMatch(/runtime agent/)
    expect(r.allocators).toBeNull()
    expect(r.memory.trend).toBeNull()
    expect(r.verdict.detail).toMatch(/Too few samples/)
    expect(buildReport(makeProc({ samples: [sample(1000, 5)], status: "exited", exitCode: 0 })).verdict.title).toBe("Finished.")
    expect(buildReport(makeProc({ runtime: "rust" })).gcNote).toMatch(/ownership/)
    expect(r.exitCode).toBeNull()
    const emptySites = buildReport(makeProc({ snapshots: [{ ...snapshot, sites: { name: "(root)", self: 0, children: [] } }] }))
    expect(emptySites.allocators!.sites).toEqual([])
  })
})

describe("exports", () => {
  const full = buildReport(makeProc({
    samples: steady(), status: "exited", exitCode: 3, signal: undefined, endedAt: 21_000, snapshots: [snapshot], alerts: [alert],
    gc: [{ t: 2000, kind: "major", pauseMs: 100, freed: 1 }],
  }))

  it("JSON round-trips the whole report", () => {
    expect(JSON.parse(reportJson(full))).toEqual(JSON.parse(JSON.stringify(full)))
  })

  it("Markdown contains the run's information", () => {
    const md = reportMarkdown(full)
    for (const part of ["# Peak run report: `node app.js`", "Duration: 20s\n", "Peak memory: 100 MiB", "1 collections (1 major)", "| `Leaky` | 10 | 40 MiB |", "`alloc` (a.js:1): 30 MiB", "`inner`: 5 MiB", "T+0:02: Memory above 100 MiB"]) {
      expect(md).toContain(part)
    }
  })

  it("Markdown states what is unknown, and qualifies unfinished durations", () => {
    const md = reportMarkdown(buildReport(makeProc({ samples: [sample(1000, 5)] })))
    expect(md).toContain("No heap snapshot was taken.")
    expect(md).toContain("No collections observed")
    expect(md).toContain("## Alerts\n\nNone.")
    expect(md).toContain("(so far)")
    expect(reportMarkdown(buildReport(makeProc({ status: "exited", signal: "peak closed" })))).toContain("(until peak closed)")
    expect(reportMarkdown(buildReport(makeProc({ snapshots: [{ ...snapshot, sites: { name: "(root)", self: 0, children: [] } }] })))).not.toContain("Allocation sites")
  })
})

describe("remote runs", () => {
  const target = { targetId: "t", label: "box", kind: "ssh" as const, launched: false, clockOffsetMs: 0, identity: { bootId: "b", pidNs: "n", pid: 1, startTicks: 1 } }

  it("don't claim an outcome nobody saw", () => {
    for (const signal of ["ended while disconnected", "target rebooted", "monitoring stopped", "stopped with the session"]) {
      const r = buildReport(makeProc({ status: "exited", signal, target, samples: steady() }))
      expect(r.state).toBe("unknown")
      expect(r.verdict.title).toBe("Outcome unknown.")
      expect(r.exitCode).toBeNull()
    }
  })

  it("record where they ran, gaps and unreadable metrics", () => {
    const r = buildReport(makeProc({ target: { ...target, launched: true }, gaps: [{ from: 0, to: 60_000 }], unavailable: ["io"] }))
    expect(r.target).toEqual({ label: "box", kind: "ssh", launched: true })
    const md = reportMarkdown(r)
    expect(md).toContain("Target: box (ssh), launched by peak")
    expect(md).toContain("Gaps in data: 1, 1m 00s in total")
    expect(md).toContain("Couldn't read: io")
    expect(reportMarkdown(buildReport(makeProc({ target }))).includes("attached")).toBe(true)
    const local = reportMarkdown(buildReport(makeProc()))
    expect(local).not.toContain("Target:")
    expect(local).not.toContain("Gaps")
  })
})

describe("topSites", () => {
  it("ranks frames by their own allocations and limits the list", () => {
    const root = { name: "r", self: 0, children: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, self: i, children: [] })) }
    expect(topSites(root, 2).map((s) => s.name)).toEqual(["f7", "f6"])
  })
})
