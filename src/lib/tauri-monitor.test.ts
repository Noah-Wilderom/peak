import { describe, expect, it, vi } from "vitest"
import { TauriMonitor, applyDelta, normalizeProc, type ProcDelta } from "@/lib/tauri-monitor"
import type { HeapSnapshot, MonitorEvent, Proc } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const system = { totalMemory: 8, cpus: 4, hostname: "h", os: "linux" }

function delta(p: Proc, over: Partial<ProcDelta> = {}): ProcDelta {
  return {
    id: p.id, samples: [], logs: [], gc: [], status: p.status, runtime: p.runtime, exe: p.exe, ppid: p.ppid,
    nice: p.nice, threads: p.threads, vsz: p.vsz, swap: p.swap, fds: p.fds, counters: p.counters, peak: p.peak,
    children: p.children, hasGc: p.hasGc, profiling: p.profiling, ...over,
  }
}

function setup(procs: Proc[] = [makeProc()], fail?: string) {
  const handlers = new Map<string, (e: { payload: unknown }) => void>()
  const calls: [string, Record<string, unknown> | undefined][] = []
  const responses: Record<string, unknown> = { get_state: { procs, system } }
  const call = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (fail && cmd === fail) throw new Error("boom")
    return responses[cmd]
  })
  const on = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb)
    return () => {}
  })
  const m = new TauriMonitor(call as never, on as never)
  const events: MonitorEvent[] = []
  m.onEvent((e) => events.push(e))
  const emit = (event: string, payload: unknown) => handlers.get(event)!({ payload })
  return { m, calls, responses, emit, events, call }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("applyDelta / normalizeProc", () => {
  it("appends new data, skipping overlap and capping history", () => {
    const p = makeProc({ logs: [{ id: 5, t: 1, stream: "stdout", text: "a" }], gc: [{ t: 10, kind: "minor", pauseMs: 1, freed: 1 }] })
    const next = applyDelta(p, delta(p, {
      samples: [sample(1500, 1), sample(2000, 300)],
      logs: [{ id: 5, t: 1, stream: "stdout", text: "a" }, { id: 6, t: 2, stream: "stderr", text: "b" }],
      gc: [{ t: 10, kind: "minor", pauseMs: 1, freed: 1 }, { t: 11, kind: "major", pauseMs: 2, freed: 2 }],
      status: "crashed", exitCode: 1, threads: 9,
    }))
    expect(next.samples.map((s) => s.t)).toEqual([1000, 1500, 2000])
    expect(next.logs.map((l) => l.id)).toEqual([5, 6])
    expect(next.gc.map((g) => g.t)).toEqual([10, 11])
    expect(next).toMatchObject({ status: "crashed", exitCode: 1, threads: 9 })
    const empty = makeProc({ samples: [], logs: [], gc: [] })
    const many = Array.from({ length: 7300 }, (_, i) => sample(2000 + i, i))
    expect(applyDelta(normalizeProc(empty), delta(empty, { samples: many })).samples).toHaveLength(7200)
  })

  it("guarantees a first sample", () => {
    const p = makeProc({ samples: [], peak: undefined as never })
    const n = normalizeProc(p)
    expect(n.samples).toEqual([expect.objectContaining({ t: p.startedAt, rss: 0 })])
    expect(n.peak).toBe(n.samples[0])
    const withPeak = makeProc({ samples: [], peak: sample(1, 99) })
    expect(normalizeProc(withPeak).peak).toBe(withPeak.peak)
    const ok = makeProc()
    expect(normalizeProc(ok)).toBe(ok)
  })
})

describe("TauriMonitor", () => {
  it("loads the full state on first subscribe", async () => {
    const { m, call } = setup([makeProc({ samples: [] })])
    expect(m.mode).toBe("tauri")
    expect(m.getSnapshot().ready).toBe(false)
    const l = vi.fn()
    const unsub = m.subscribe(l)
    m.subscribe(vi.fn())
    await flush()
    const s = m.getSnapshot()
    expect(s).toMatchObject({ ready: true, system, selectedId: "p1" })
    expect(s.procs[0].samples).toHaveLength(1)
    expect(l).toHaveBeenCalled()
    expect(call.mock.calls.filter(([c]) => c === "get_state")).toHaveLength(1)
    unsub()
  })

  it("keeps a selection made before the state arrived", async () => {
    const { m, events } = setup([makeProc({ id: "a" }), makeProc({ id: "b" })])
    m.select("b")
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot().selectedId).toBe("b")
    const got: unknown[] = []
    const off = m.onEvent((e) => got.push(e))
    off()
    m.onTick({ procs: [], system: null })
    expect(got).toEqual([])
    expect(events).toEqual([])
  })

  it("starts empty", async () => {
    const { m } = setup([])
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot()).toMatchObject({ ready: true, selectedId: null, procs: [] })
  })

  it("reports a failed start", async () => {
    const { m } = setup([], "get_state")
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot()).toMatchObject({ ready: true, error: "Error: boom", selectedId: null })
  })

  it("applies ticks and announces endings", async () => {
    const a = makeProc({ id: "a" })
    const b = makeProc({ id: "b" })
    const { m, emit, events } = setup([a, b])
    m.subscribe(vi.fn())
    await flush()
    emit("peak://tick", { procs: [delta(a, { samples: [sample(5000, 9)] })], system: null })
    expect(m.getSnapshot().procs[0].samples.at(-1)!.t).toBe(5000)
    emit("peak://tick", { procs: [delta(a, { status: "exited" }), delta(b, { status: "crashed" })], system: null })
    expect(events.map((e) => e.type)).toEqual(["exited", "crashed"])
    emit("peak://tick", { procs: [delta(a, { status: "exited" })], system: null })
    expect(events).toHaveLength(2)
  })

  it("keeps a bounded machine history", async () => {
    const { m, emit } = setup([])
    m.subscribe(vi.fn())
    await flush()
    const sys = { t: 1, memTotal: 8, memAvailable: 4, swapTotal: 0, swapFree: 0, psiSome: 0, psiFull: 0, load1: 1, cpu: 50 }
    emit("peak://tick", { procs: [], system: sys })
    emit("peak://tick", { procs: [], system: { ...sys, t: 2 } })
    expect(m.getSnapshot().machine!.map((s) => s.t)).toEqual([1, 2])
  })

  it("freezes while paused", async () => {
    const a = makeProc({ id: "a" })
    const { m, emit } = setup([a])
    m.subscribe(vi.fn())
    await flush()
    m.setPaused(true)
    emit("peak://tick", { procs: [delta(a, { samples: [sample(9000, 1)] })], system: null })
    expect(m.getSnapshot().procs[0].samples.at(-1)!.t).toBe(1500)
    m.select("a")
    m.setPaused(false)
    expect(m.getSnapshot().procs[0].samples.at(-1)!.t).toBe(9000)
    m.setPaused(false)
    expect(m.getSnapshot().paused).toBe(false)
  })

  it("adds processes announced by the CLI", async () => {
    const { m, emit, events } = setup([makeProc({ id: "other" })])
    m.subscribe(vi.fn())
    await flush()
    emit("peak://proc", makeProc({ id: "cli" }))
    expect(m.getSnapshot().selectedId).toBe("cli")
    emit("peak://proc", makeProc({ id: "cli", command: "updated" }))
    expect(m.getSnapshot().procs).toHaveLength(2)
    expect(m.getSnapshot().procs[0].command).toBe("updated")
    expect(events.filter((e) => e.type === "captured")).toHaveLength(1)
    // While paused, new processes land in the hidden state but still get selected.
    m.setPaused(true)
    emit("peak://proc", makeProc({ id: "late" }))
    expect(m.getSnapshot().selectedId).toBe("late")
    expect(m.getSnapshot().procs.some((p) => p.id === "late")).toBe(false)
    m.setPaused(false)
    expect(m.getSnapshot().procs[0].id).toBe("late")
  })

  it("invokes backend commands", async () => {
    const a = makeProc({ id: "a" })
    const { m, calls, responses, events } = setup([a, makeProc({ id: "old", status: "exited" })])
    m.subscribe(vi.fn())
    await flush()

    responses.capture = makeProc({ id: "c" })
    await m.capture("bun run build", "~")
    expect(calls).toContainEqual(["capture", { command: "bun run build", cwd: "~" }])
    expect(m.getSnapshot().selectedId).toBe("c")

    responses.attach = makeProc({ id: "d" })
    await m.attach(7)
    expect(calls).toContainEqual(["attach", { pid: 7 }])

    responses.list_attachable = [{ pid: 1, command: "x", cwd: "/", rss: 1 }]
    expect(await m.listAttachable()).toHaveLength(1)

    const snap = { id: "s", t: 1, heapUsed: 1, entries: [], sites: { name: "(root)", self: 0, children: [] } } as HeapSnapshot
    responses.take_snapshot = snap
    expect(await m.takeSnapshot("a")).toBe(snap)
    expect(m.getSnapshot().procs.find((p) => p.id === "a")!.snapshots).toEqual([snap])
    expect(events.some((e) => e.type === "snapshot")).toBe(true)
    responses.take_snapshot = snap
    await m.takeSnapshot("missing")

    m.forceGc("a")
    m.kill("a")
    responses.restart = makeProc({ id: "a2" })
    m.restart("a")
    await flush()
    expect(m.getSnapshot().procs.some((p) => p.id === "a2")).toBe(true)
    expect(m.getSnapshot().selectedId).toBe("a2")

    m.select("old")
    m.remove("old")
    expect(m.getSnapshot().procs.some((p) => p.id === "old")).toBe(false)
    expect(m.getSnapshot().selectedId).toBe(m.getSnapshot().procs[0].id)
    m.remove("d")
    m.clearEnded()
    await flush()
    expect(calls.map(([c]) => c)).toEqual(expect.arrayContaining(["force_gc", "stop", "restart", "remove", "clear_ended"]))
  })

  it("selects nothing after removing the only process", async () => {
    const { m } = setup([makeProc({ id: "solo", status: "exited" })])
    m.subscribe(vi.fn())
    await flush()
    m.remove("solo")
    expect(m.getSnapshot().selectedId).toBeNull()
  })

  it("keeps the selection when clearing and surfaces command errors", async () => {
    const { m, call } = setup([makeProc({ id: "a" }), makeProc({ id: "b", status: "exited" })])
    m.subscribe(vi.fn())
    await flush()
    m.select("a")
    m.clearEnded()
    expect(m.getSnapshot().selectedId).toBe("a")
    m.select("b")
    m.remove("a")
    expect(m.getSnapshot().selectedId).toBe("b")
    call.mockRejectedValue(new Error("nope"))
    m.kill("b")
    await flush()
    expect(m.getSnapshot().error).toBe("Error: nope")
    m.clearEnded()
    await flush()
    expect(m.getSnapshot().selectedId).toBeNull()
    m.remove("zzz")
    expect(m.getSnapshot().selectedId).toBeNull()
  })
})
