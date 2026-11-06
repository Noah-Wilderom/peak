import { describe, expect, it } from "vitest"
import { nearestMarker, timelineMarkers } from "@/lib/markers"
import { makeProc } from "@/test/fixtures"

const proc = makeProc({
  logs: [
    { id: 1, t: 1000, stream: "stdout", text: "fine" },
    { id: 2, t: 2000, stream: "stderr", text: "bad thing" },
    { id: 3, t: 99_000, stream: "stderr", text: "outside" },
  ],
  gc: [{ t: 3000, kind: "major", pauseMs: 12.34, freed: 1 }, { t: 3500, kind: "minor", pauseMs: 1, freed: 1 }],
  snapshots: [{ id: "s", t: 4000, heapUsed: 1024, entries: [], sites: { name: "r", self: 0, children: [] } }],
  alerts: [{ t: 5000, kind: "memory", message: "Memory reached 1 GiB", value: 1, threshold: 1 }],
})

describe("timelineMarkers", () => {
  it("collects stderr, major GCs, snapshots and alerts inside the window", () => {
    expect(timelineMarkers(proc, 0, 10_000)).toEqual([
      { t: 2000, kind: "stderr", label: "bad thing" },
      { t: 3000, kind: "gc", label: "Major GC · 12.3ms pause" },
      { t: 4000, kind: "snapshot", label: "Heap snapshot · 1 KiB" },
      { t: 5000, kind: "alert", label: "Memory reached 1 GiB" },
    ])
    expect(timelineMarkers(proc, 4500, 10_000).map((m) => m.kind)).toEqual(["alert"])
    expect(timelineMarkers(makeProc(), 0, 10_000), "no alerts field, no events").toEqual([])
  })

  it("merges dense events per kind with a count", () => {
    const logs = Array.from({ length: 500 }, (_, i) => ({ id: i, t: i, stream: "stderr" as const, text: "x" }))
    const gc = Array.from({ length: 3 }, (_, i) => ({ t: i, kind: "major" as const, pauseMs: 1, freed: 0 }))
    const snapshots = [0, 1].map((t) => ({ id: `${t}`, t, heapUsed: 1, entries: [], sites: { name: "r", self: 0, children: [] } }))
    const alerts = [0, 1].map((t) => ({ t, kind: "cpu" as const, message: "m", value: 0, threshold: 0 }))
    const out = timelineMarkers(makeProc({ logs, gc, snapshots, alerts }), 0, 80_000)
    expect(out.map((m) => m.label)).toEqual(["500 stderr lines", "3 major GCs", "2 heap snapshots", "2 alerts"])
    expect(timelineMarkers(makeProc({ logs }), 0, 0), "a zero-length window doesn't divide by zero").toHaveLength(1)
  })
})

describe("nearestMarker", () => {
  const markers = timelineMarkers(proc, 0, 10_000)
  it("finds the closest event within reach", () => {
    expect(nearestMarker(markers, 3100, 500)!.t).toBe(3000)
    expect(nearestMarker(markers, 3600, 900)!.t).toBe(4000)
    expect(nearestMarker(markers, 8000, 100)).toBeNull()
  })
})
