import { describe, expect, it, vi } from "vitest"
import { TauriMonitor, applyDelta, normalizeProc, type ProcDelta } from "@/lib/tauri-monitor"
import { DEFAULT_SETTINGS, type HeapSnapshot, type MonitorEvent, type Proc } from "@/lib/types"
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
  const responses: Record<string, unknown> = { get_state: { procs, system }, get_settings: DEFAULT_SETTINGS }
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

  it("selects a run that `peak open` asks for", async () => {
    const { m, emit } = setup([makeProc({ id: "a" }), makeProc({ id: "b" })])
    await m.start()
    await flush()
    emit("peak://open", "b")
    expect(m.getSnapshot().selectedId).toBe("b")
    expect(m.getSnapshot().openRequest).toEqual({ id: "b", seq: 1 })
    emit("peak://open", "b")
    expect(m.getSnapshot().openRequest).toEqual({ id: "b", seq: 2 })
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

  it("evaluates saved thresholds on incoming samples and records what fires", async () => {
    const { m, calls, responses, emit, events } = setup([makeProc({ samples: [sample(1000, 1)] })])
    responses.get_settings = { ...DEFAULT_SETTINGS, alertMemoryMib: 1 }
    m.subscribe(vi.fn())
    await flush()
    const p = m.getSnapshot().procs[0]
    const over = 2 * 1024 * 1024
    emit("peak://tick", { procs: [delta(p, { samples: [sample(2000, over)] })], system: null })
    expect(events).toEqual([expect.objectContaining({ type: "alert", notify: true })])
    expect(m.getSnapshot().procs[0].alerts).toHaveLength(1)
    const recorded = calls.find(([c]) => c === "add_alert")!
    expect(recorded[1]).toMatchObject({ id: "p1", alert: { kind: "memory", value: over } })

    // Still over: no duplicate. New settings apply to the next sample.
    emit("peak://tick", { procs: [delta(p, { samples: [sample(3000, over)] })], system: null })
    expect(events).toHaveLength(1)
    responses.set_settings = { ...DEFAULT_SETTINGS, alertMemoryMib: 0.5, notifications: false }
    await m.setSettings(responses.set_settings as never)
    emit("peak://tick", { procs: [delta(p, { samples: [sample(4000, over)] })], system: null })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ notify: false })
  })

  it("adds recorded CPU profiles to the run", async () => {
    const { m, calls, responses } = setup([makeProc({ id: "a" }), makeProc({ id: "b", cpuProfiles: [] })])
    m.subscribe(vi.fn())
    await flush()
    const profile = { id: "c", t: 1, durationMs: 5, sampling: "v8", root: { name: "r", self: 0, children: [] } }
    responses.cpu_profile = profile
    expect(await m.cpuProfile("a", 5000)).toBe(profile)
    expect(calls.at(-1)).toEqual(["cpu_profile", { id: "a", ms: 5000 }])
    expect(m.getSnapshot().procs[0].cpuProfiles).toEqual([profile])
    await m.cpuProfile("a", 5000)
    expect(m.getSnapshot().procs[0].cpuProfiles).toHaveLength(2)
    expect(m.getSnapshot().procs[1].cpuProfiles).toEqual([])
  })

  it("routes targets and discovery to the backend, and tracks connection state", async () => {
    const { m, calls, responses, emit, events } = setup()
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot().targets).toEqual([])
    const state = (id: string, s = "disconnected") => ({ spec: { id }, state: s })
    responses.add_target = state("t")
    await m.addTarget({ id: "t" } as never)
    await m.addTarget({ id: "t" } as never)
    expect(m.getSnapshot().targets).toHaveLength(1)
    emit("peak://tick", { procs: [], system: null, targets: [state("t", "connected")] })
    expect(m.getSnapshot().targets[0].state).toBe("connected")
    await m.connectTarget("t")
    expect(calls.at(-1)).toEqual(["connect_target", { id: "t" }])
    await m.disconnectTarget("t")
    expect(calls.at(-1)).toEqual(["disconnect_target", { id: "t" }])
    responses.list_target_processes = [{ pid: 1 }]
    expect(await m.listTargetProcesses("t")).toEqual([{ pid: 1 }])

    const run = makeProc({ id: "t~1", target: { targetId: "t" } as never })
    responses.attach_target = run
    await m.attachTarget("t", 1)
    expect(calls.at(-1)).toEqual(["attach_target", { id: "t", pid: 1 }])
    expect(m.getSnapshot().procs[0].id).toBe("t~1")
    expect(events.at(-1)).toMatchObject({ type: "captured" })
    responses.launch_target = makeProc({ id: "t~2" })
    const spec = { command: "x", cwd: "/" }
    await m.launchTarget("t", spec)
    expect(calls.at(-1)).toEqual(["launch_target", { id: "t", spec }])
    await m.detach("t~1")
    expect(calls.at(-1)).toEqual(["detach", { id: "t~1" }])
    await m.signal("t~1", "TERM")
    expect(calls.at(-1)).toEqual(["signal_run", { id: "t~1", signal: "TERM" }])
    await m.removeTarget("t")
    expect(m.getSnapshot().targets).toEqual([])

    for (const [name, args, cmd, want] of [
      ["dockerContexts", [], "docker_contexts", undefined],
      ["dockerContainers", ["c"], "docker_containers", { context: "c" }],
      ["dockerTotals", ["c", "i"], "docker_totals", { context: "c", id: "i" }],
      ["dockerTop", ["c", "i"], "docker_top", { context: "c", id: "i" }],
      ["dockerLogs", ["c", "i", 5], "docker_logs", { context: "c", id: "i", tail: 5 }],
      ["kubeContexts", [], "kube_contexts", undefined],
      ["kubeNamespaces", ["c"], "kube_namespaces", { context: "c" }],
      ["kubePods", ["c", "n"], "kube_pods", { context: "c", namespace: "n" }],
      ["kubeLogs", ["c", "n", "p", "a", 5], "kube_logs", { context: "c", namespace: "n", pod: "p", container: "a", tail: 5 }],
      ["kubeMetrics", ["c", "n", "p"], "kube_metrics", { context: "c", namespace: "n", pod: "p" }],
      ["kubeAccess", ["c", "n"], "kube_access", { context: "c", namespace: "n" }],
    ] as const) {
      await (m as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args)
      expect(calls.at(-1)).toEqual([cmd, want])
    }
  })

  it("loads targets from the full state", async () => {
    const { m, responses } = setup()
    ;(responses.get_state as { targets?: unknown[] }).targets = [{ spec: { id: "t" }, state: "connected" }]
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot().targets).toHaveLength(1)
  })

  it("carries unreadable-metric markers on deltas", () => {
    const p = makeProc()
    expect(applyDelta(p, delta(p, { unavailable: ["io"] })).unavailable).toEqual(["io"])
  })

  it("takes gaps and clock offsets from the backend, which is the only one who knows", () => {
    const target = { targetId: "t", label: "l", kind: "ssh" as const, launched: false, clockOffsetMs: 1, identity: { bootId: "b", pidNs: "n", pid: 1, startTicks: 1 } }
    const p = makeProc({ target, gaps: [{ from: 1, to: 2 }] })
    const next = applyDelta(p, delta(p, { gaps: [{ from: 1, to: 2 }, { from: 5, to: 9 }], clockOffsetMs: 250 }))
    expect(next.gaps).toHaveLength(2)
    expect(next.target!.clockOffsetMs).toBe(250)
    const quiet = applyDelta(p, delta(p))
    expect(quiet.gaps, "an update without them doesn't forget them").toEqual(p.gaps)
    expect(quiet.target!.clockOffsetMs).toBe(1)
    const local = applyDelta(makeProc(), delta(makeProc(), { clockOffsetMs: 5 }))
    expect(local.target).toBeUndefined()
  })

  it("keeps monitoring when thresholds can't be read", async () => {
    const { m } = setup([makeProc()], "get_settings")
    m.subscribe(vi.fn())
    await flush()
    expect(m.getSnapshot().ready).toBe(true)
    expect(m.getSnapshot().error).toBeUndefined()
    expect(m.getSnapshot().procs).toHaveLength(1)
  })

  it("reads and maintains stored history through the backend", async () => {
    const running = makeProc({ id: "live" })
    const ended = makeProc({ id: "old", status: "exited" })
    const { m, calls, responses, events } = setup([running, ended])
    m.subscribe(vi.fn())
    await flush()
    const stored = makeProc({ id: "stored", status: "exited", historical: true, samples: [] })
    Object.assign(responses, {
      list_runs: [{ id: "stored" }],
      open_run: stored,
      load_run: makeProc({ id: "cmp", samples: [] }),
      delete_run: true,
      prune_runs: 2,
      storage_info: { path: "p", bytes: 1, runs: 1, stoppedRuns: 1, samples: 1 },
      get_settings: { maxRuns: 7 },
      set_settings: { maxRuns: 8 },
    })

    expect(await m.listRuns("vite")).toEqual([{ id: "stored" }])
    expect(calls.at(-1)).toEqual(["list_runs", { query: "vite" }])
    await m.listRuns()
    expect(calls.at(-1)).toEqual(["list_runs", { query: null }])

    // Comparing never touches the session; opening does, and is not announced as a new capture.
    const loaded = await m.loadRun("cmp")
    expect(loaded.samples).toHaveLength(1)
    expect(m.getSnapshot().procs.map((p) => p.id)).toEqual(["live", "old"])
    await m.openRun("stored")
    expect(m.getSnapshot().procs[0]).toMatchObject({ id: "stored", historical: true })
    expect(m.getSnapshot().selectedId).toBe("stored")
    expect(events).toEqual([])

    expect(await m.deleteRun("stored")).toBe(true)
    expect(m.getSnapshot().procs.map((p) => p.id)).toEqual(["live", "old"])
    expect(m.getSnapshot().selectedId).toBe("live")

    expect(await m.pruneRuns(30)).toBe(2)
    expect(calls.at(-1)).toEqual(["prune_runs", { olderThanDays: 30 }])
    expect(m.getSnapshot().procs.map((p) => p.id), "age pruning leaves the session alone").toEqual(["live", "old"])
    await m.pruneRuns()
    expect(calls.at(-1)).toEqual(["prune_runs", { olderThanDays: null }])
    expect(m.getSnapshot().procs.map((p) => p.id), "active work survives").toEqual(["live"])

    expect((await m.storageInfo()).bytes).toBe(1)
    await m.vacuum()
    expect(calls.at(-1)).toEqual(["vacuum", undefined])
    expect(await m.getSettings()).toEqual({ maxRuns: 7 })
    const next = { maxRuns: 8 } as never
    expect(await m.setSettings(next)).toEqual({ maxRuns: 8 })
    expect(calls.at(-1)).toEqual(["set_settings", { settings: next }])
  })

  it("keeps the selection when clearing and surfaces command errors", async () => {
    const { m, call } = setup([makeProc({ id: "a" }), makeProc({ id: "b", status: "exited" })])
    m.subscribe(vi.fn())
    await flush()
    m.select("a")
    m.clearEnded()
    expect(m.getSnapshot().selectedId).toBe("a")
    // "b" ended and was cleared, so a selection pointing at it can't survive.
    m.select("b")
    m.remove("a")
    expect(m.getSnapshot().selectedId).toBeNull()
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
