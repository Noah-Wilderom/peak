import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MockMonitor, type MonitorEvent } from "@/lib/mock"
import { DEFAULT_SETTINGS, NEW_TARGET, TICK_MS, frameTotal } from "@/lib/types"

describe("MockMonitor", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const m = new MockMonitor()
    const events: MonitorEvent[] = []
    const off = m.onEvent((e) => events.push(e))
    const changes = vi.fn()
    const unsub = m.subscribe(changes)
    return { m, events, changes, off, unsub }
  }

  it("seeds a realistic fleet", () => {
    const m = new MockMonitor()
    const s = m.getSnapshot()
    expect(s.ready).toBe(true)
    expect(s.procs.length).toBe(6)
    expect(s.selectedId).toBe(s.procs[0].id)
    expect(s.procs.filter((p) => p.status === "running")).toHaveLength(4)
    const crashed = s.procs.find((p) => p.status === "crashed")!
    expect(crashed.signal).toBe("SIGKILL")
    expect(crashed.logs.at(-1)!.text).toMatch(/out of memory/)
    const built = s.procs.find((p) => p.command === "bun run build")!
    expect(built.status).toBe("exited")
    for (const p of s.procs) {
      expect(p.samples.length).toBeGreaterThan(0)
      expect(p.peak.rss).toBeGreaterThan(0)
    }
    expect(s.procs.find((p) => p.runtime === "rust")!.hasGc).toBe(false)
    expect(s.procs.some((p) => p.snapshots.length >= 2)).toBe(true)
  })

  it("keeps past runs in history without adding them to the session", async () => {
    const m = new MockMonitor()
    const before = m.getSnapshot().procs.map((p) => p.id)
    const runs = await m.listRuns()
    expect(runs.length).toBeGreaterThan(before.length)
    expect(runs.map((r) => r.startedAt)).toEqual([...runs.map((r) => r.startedAt)].sort((a, b) => b - a))
    const builds = await m.listRuns("BUN RUN BUILD")
    expect(builds.length).toBeGreaterThanOrEqual(4)
    expect(builds.every((r) => r.command === "bun run build")).toBe(true)
    const past = builds.at(-1)!
    expect(past.peakRss).toBeGreaterThan(0)
    expect(past.avgCpu).toBeGreaterThan(0)

    const loaded = await m.loadRun(past.id)
    expect(loaded.id).toBe(past.id)
    expect(m.getSnapshot().procs.map((p) => p.id)).toEqual(before)
    await expect(m.loadRun("nope")).rejects.toThrow("run not found")

    await m.openRun(past.id)
    expect(m.getSnapshot().selectedId).toBe(past.id)
    expect(m.getSnapshot().procs[0]).toMatchObject({ id: past.id, historical: true })
    // Opening something already in the session just selects it.
    await m.openRun(before[1])
    expect(m.getSnapshot().selectedId).toBe(before[1])
    expect(m.getSnapshot().procs.filter((p) => p.id === before[1])).toHaveLength(1)
  })

  it("deletes, prunes and compacts history, leaving running work alone", async () => {
    const m = new MockMonitor()
    const running = m.getSnapshot().procs.find((p) => p.status === "running")!
    await expect(m.deleteRun(running.id)).rejects.toThrow("stop the process")
    expect(await m.deleteRun("nope")).toBe(false)

    const start = await m.storageInfo()
    expect(start.path).toMatch(/mock/)
    const victim = (await m.listRuns("npm test")).at(-1)!
    expect(await m.deleteRun(victim.id)).toBe(true)
    expect((await m.listRuns()).some((r) => r.id === victim.id)).toBe(false)
    const afterDelete = await m.storageInfo()
    expect(afterDelete.runs).toBe(start.runs - 1)
    expect(afterDelete.bytes, "deleted space isn't reclaimed until a vacuum").toBe(start.bytes)
    await m.vacuum()
    expect((await m.storageInfo()).bytes).toBeLessThan(start.bytes)

    // Removing from the session keeps the run in history.
    const ended = m.getSnapshot().procs.find((p) => p.status !== "running")!
    m.remove(ended.id)
    expect((await m.listRuns()).some((r) => r.id === ended.id)).toBe(true)
    // ...and so does running it again.
    const again = m.getSnapshot().procs.find((p) => p.status !== "running")!
    m.restart(again.id)
    expect((await m.listRuns()).some((r) => r.id === again.id)).toBe(true)

    const liveBefore = m.getSnapshot().procs.filter((p) => p.status === "running").length
    expect(await m.pruneRuns(30), "only the 45-day-old run is older than 30 days").toBe(1)
    expect(await m.pruneRuns()).toBeGreaterThan(0)
    expect(m.getSnapshot().procs.filter((p) => p.status === "running")).toHaveLength(liveBefore)
    expect((await m.storageInfo()).stoppedRuns).toBe(0)
    expect(await m.pruneRuns()).toBe(0)
  })

  it("raises alerts from saved thresholds as it samples", async () => {
    localStorage.clear()
    const { m, events } = setup()
    await m.setSettings({ ...DEFAULT_SETTINGS, alertMemoryMib: 1 })
    vi.advanceTimersByTime(TICK_MS)
    const alerts = events.filter((e) => e.type === "alert")
    const running = m.getSnapshot().procs.filter((p) => p.status === "running")
    expect(alerts).toHaveLength(running.length)
    expect(alerts[0]).toMatchObject({ notify: true })
    expect(running[0].alerts).toHaveLength(1)
    vi.advanceTimersByTime(TICK_MS)
    expect(events.filter((e) => e.type === "alert"), "one per crossing").toHaveLength(running.length)
    localStorage.clear()
  })

  it("reports resources, and lag only where an agent could measure it", () => {
    const m = new MockMonitor()
    const procs = m.getSnapshot().procs
    const node = procs.find((p) => p.runtime === "bun")!
    const last = node.samples.at(-1)!
    expect(last.threads).toBeGreaterThan(0)
    expect(last.files).toBeGreaterThan(0)
    expect(last.loopLag).toBeGreaterThanOrEqual(0)
    expect(last.kids!.length).toBe(node.children.length)
    expect(node.childNames![last.kids![0].pid]).toBe(node.children[0].name)
    expect(node.ports!.length).toBeGreaterThan(0)
    const bare = procs.find((p) => !p.profiling)
    expect(bare?.samples.at(-1)!.loopLag).toBeUndefined()
  })

  it("keeps a bounded machine history that freezes with the view", () => {
    const { m } = setup()
    const before = m.getSnapshot().machine!
    expect(before.length).toBeGreaterThan(0)
    vi.advanceTimersByTime(TICK_MS)
    const after = m.getSnapshot().machine!
    expect(after).toHaveLength(before.length + 1)
    expect(after.at(-1)!.memTotal).toBeGreaterThan(after.at(-1)!.memAvailable)
    m.setPaused(true)
    vi.advanceTimersByTime(TICK_MS)
    expect(m.getSnapshot().machine).toHaveLength(after.length)
    m.setPaused(false)
  })

  it("records CPU profiles only with an agent, naming how it sampled", async () => {
    const m = new MockMonitor()
    const procs = m.getSnapshot().procs
    const node = procs.find((p) => p.runtime === "node")!
    const py = procs.find((p) => p.runtime === "python" && p.status === "running")!
    const a = m.cpuProfile(node.id, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    const profile = await a
    expect(profile.sampling).toBe("v8")
    expect(frameTotal(profile.root)).toBeCloseTo(5000)
    expect(m.getSnapshot().procs.find((p) => p.id === node.id)!.cpuProfiles).toEqual([profile])
    const b = m.cpuProfile(py.id, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect((await b).sampling).toBe("stack")
    await m.capture("make all", "~")
    await expect(m.cpuProfile(m.getSnapshot().procs[0].id, 10)).rejects.toThrow("no profiling agent")
    await expect(m.cpuProfile("nope", 10)).rejects.toThrow("no profiling agent")
  })

  describe("simulated targets", () => {
    const connected = async () => {
      const ctx = setup()
      const id = ctx.m.getSnapshot().targets[0].spec.id
      await ctx.m.connectTarget(id)
      expect(ctx.m.getSnapshot().targets[0].state).toBe("connecting")
      await vi.advanceTimersByTimeAsync(500)
      expect(ctx.m.getSnapshot().targets[0].state).toBe("connected")
      return { ...ctx, id }
    }

    it("are labelled as simulated and start disconnected, promising nothing", () => {
      const t = new MockMonitor().getSnapshot().targets[0]
      expect(t.spec.label).toMatch(/simulated/)
      expect(t.state).toBe("disconnected")
      expect(t.capabilities.attach).toBe(false)
    })

    it("attach and launch route to the target and label the run", async () => {
      const { m, id, events } = await connected()
      const list = await m.listTargetProcesses(id)
      await m.attachTarget(id, list[0].pid)
      const attached = m.getSnapshot().procs[0]
      expect(attached.id.startsWith(`${id}~`)).toBe(true)
      expect(attached.target).toMatchObject({ targetId: id, launched: false })
      expect(attached.logs, "attaching can't promise past output").toEqual([])
      expect(attached.profiling, "an existing process has no agent").toBe(false)
      await m.attachTarget(id, 999)
      expect(m.getSnapshot().procs[0].command).toBe("pid 999")
      expect(events.filter((e) => e.type === "captured")).toHaveLength(2)

      await m.launchTarget(id, { command: "node server.js", cwd: "/srv" })
      const launched = m.getSnapshot().procs[0]
      expect(launched.target).toMatchObject({ launched: true, spec: { command: "node server.js" } })
      expect(launched.profiling).toBe(true)
      await m.launchTarget(id, { argv: ["/bin/x", "y"], cwd: "/" })
      expect(m.getSnapshot().procs[0].command).toBe("/bin/x y")

      m.kill(launched.id)
      m.restart(launched.id)
      const again = m.getSnapshot().procs.find((p) => p.id === m.getSnapshot().selectedId)!
      expect(again.target?.targetId, "it runs again on the same target").toBe(id)
      expect(again.id).not.toBe(launched.id)
    })

    it("losing the link stops data but not the workload, and shows a gap afterwards", async () => {
      const { m, id } = await connected()
      await m.attachTarget(id, 812)
      const run = () => m.getSnapshot().procs.find((p) => p.target)!
      vi.advanceTimersByTime(TICK_MS)
      const before = run().samples.length
      await m.disconnectTarget(id)
      vi.advanceTimersByTime(TICK_MS * 3)
      expect(run().status).toBe("running")
      expect(run().samples).toHaveLength(before)
      expect(m.getSnapshot().targets[0].capabilities.attach).toBe(false)
      await expect(m.listTargetProcesses(id)).rejects.toThrow("not connected")
      await expect(m.listTargetProcesses("nope")).rejects.toThrow("unknown target")
      await m.connectTarget(id)
      await vi.advanceTimersByTimeAsync(500)
      expect(run().gaps).toHaveLength(1)
      vi.advanceTimersByTime(TICK_MS)
      expect(run().samples.length).toBeGreaterThan(before)
    })

    it("disconnecting ends what the session launched, and says so", async () => {
      const { m, id } = await connected()
      await m.launchTarget(id, { command: "node job.js", cwd: "/" })
      const run = m.getSnapshot().procs[0].id
      await m.disconnectTarget(id)
      expect(m.getSnapshot().procs[0]).toMatchObject({ id: run, status: "exited", signal: "stopped with the session" })
    })

    it("detaching and signalling are distinct, and a watched target can't be removed", async () => {
      const { m, id } = await connected()
      await m.attachTarget(id, 812)
      const run = m.getSnapshot().procs[0]
      await expect(m.removeTarget(id)).rejects.toThrow("detach")
      await m.detach(run.id)
      expect(m.getSnapshot().procs[0]).toMatchObject({ status: "exited", signal: "monitoring stopped" })
      await m.attachTarget(id, 1204)
      await m.signal(m.getSnapshot().procs[0].id, "TERM")
      expect(m.getSnapshot().procs[0].signal).toBe("SIGTERM")
      await m.removeTarget(id)
      expect(m.getSnapshot().targets).toEqual([])
    })

    it("adds targets and replaces by id; container kinds get container capabilities", async () => {
      const { m } = setup()
      const a = await m.addTarget({ ...NEW_TARGET, label: "d", kind: "docker" })
      expect(a.spec.id).toBeTruthy()
      await m.addTarget({ ...a.spec, label: "renamed" })
      expect(m.getSnapshot().targets.filter((t) => t.spec.id === a.spec.id).map((t) => t.spec.label)).toEqual(["renamed"])
      await m.connectTarget(a.spec.id)
      await vi.advanceTimersByTimeAsync(500)
      const t = m.getSnapshot().targets.find((x) => x.spec.id === a.spec.id)!
      expect(t.capabilities.containerTotals).toBe(true)
      expect(t.facts!.limits.memoryMax).toBeGreaterThan(0)
      const b = await m.addTarget({ ...NEW_TARGET, id: "k", label: "k", kind: "kubernetes" })
      await m.connectTarget(b.spec.id)
      await vi.advanceTimersByTimeAsync(500)
      const k = m.getSnapshot().targets.find((x) => x.spec.id === "k")!
      expect((k.capabilities.containerLogs, k.capabilities.containerTotals)).toBe(false)
    })

    it("offers simulated discovery", async () => {
      const m = new MockMonitor()
      expect(await m.dockerContexts()).toContain("default")
      expect((await m.dockerContainers())[0].name).toMatch(/simulated/)
      expect((await m.dockerTotals()).memoryLimit).toBeGreaterThan(0)
      expect(await m.dockerTop()).toHaveLength(2)
      expect(await m.dockerLogs()).toMatch(/simulated/)
      expect(await m.kubeContexts()).toEqual(["kind-dev"])
      expect(await m.kubeNamespaces()).toContain("web")
      expect(await m.kubePods("", "default")).toHaveLength(1)
      expect(await m.kubePods("", "web")).toEqual([])
      expect(await m.kubeLogs()).toMatch(/simulated/)
      expect(await m.kubeMetrics()).toBeNull()
      expect((await m.kubeAccess()).exec).toBe(true)
    })
  })

  it("seeds a run with an alert to show", () => {
    const crashed = new MockMonitor().getSnapshot().procs.find((p) => p.status === "crashed")!
    expect(crashed.alerts![0].kind).toBe("memory")
    expect(crashed.alerts![0].t).toBeLessThanOrEqual(crashed.endedAt!)
  })

  it("persists settings where the browser allows it", async () => {
    localStorage.clear()
    const m = new MockMonitor()
    const defaults = await m.getSettings()
    expect(defaults).toEqual(DEFAULT_SETTINGS)
    await m.setSettings({ ...defaults, maxRuns: 9 })
    expect((await m.getSettings()).maxRuns).toBe(9)
    expect((await new MockMonitor().getSettings()).maxRuns, "survives a restart").toBe(9)

    localStorage.setItem("peak-mock-settings", "{broken")
    expect(await new MockMonitor().getSettings()).toEqual(DEFAULT_SETTINGS)
    localStorage.clear()

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    expect((await m.setSettings({ ...defaults, maxRuns: 3 })).maxRuns).toBe(3)
    expect((await m.getSettings()).maxRuns, "still applies for the session").toBe(3)
  })

  it("streams samples while subscribed and stops when the last listener leaves", () => {
    const { m, changes, unsub } = setup()
    const before = m.getSnapshot().procs[0].samples.length
    vi.advanceTimersByTime(TICK_MS * 3)
    expect(changes).toHaveBeenCalled()
    expect(m.getSnapshot().procs[0].samples.length).toBeGreaterThan(before)
    unsub()
    changes.mockClear()
    vi.advanceTimersByTime(TICK_MS * 3)
    expect(changes).not.toHaveBeenCalled()
    // Subscribing twice keeps a single timer.
    const a = m.subscribe(vi.fn())
    const b = m.subscribe(vi.fn())
    a()
    b()
  })

  it("freezes the view while paused but keeps sampling", () => {
    const { m } = setup()
    m.setPaused(true)
    const frozen = m.getSnapshot().procs[0].samples.length
    vi.advanceTimersByTime(TICK_MS * 4)
    expect(m.getSnapshot().procs[0].samples.length).toBe(frozen)
    m.setPaused(false)
    expect(m.getSnapshot().procs[0].samples.length).toBeGreaterThan(frozen)
    m.setPaused(false)
    expect(m.getSnapshot().paused).toBe(false)
  })

  it("captures, attaches and lists", async () => {
    const { m, events } = setup()
    for (const cmd of ["bun run build", "npm test", "python etl.py", "node server.js", "node worker.js", "make", "go run .", "cargo build", "bunx x", "uv run a.py"]) {
      await m.capture(cmd, "")
    }
    expect(events.filter((e) => e.type === "captured")).toHaveLength(10)
    const s = m.getSnapshot()
    expect(s.selectedId).toBe(s.procs[0].id)
    expect(s.procs[0].cwd).toBe("~")
    expect(s.procs.find((p) => p.command === "go run .")!.profiling).toBe(false)
    const list = await m.listAttachable()
    expect(list.length).toBe(3)
    await m.attach(list[0].pid)
    expect(m.getSnapshot().procs[0].command).toBe(list[0].command)
    await m.attach(123)
    expect(m.getSnapshot().procs[0].command).toBe("pid 123")
  })

  it("runs processes to completion and reports how they ended", async () => {
    const { m, events } = setup()
    await m.capture("npm test", "~")
    vi.advanceTimersByTime(TICK_MS * 100)
    const done = m.getSnapshot().procs.find((p) => p.command === "npm test")!
    expect(done.status).toBe("exited")
    expect(events.some((e) => e.type === "exited")).toBe(true)
    await m.capture("npm run lint", "~")
    vi.advanceTimersByTime(TICK_MS * 40)
    const lint = m.getSnapshot().procs.find((p) => p.command === "npm run lint")!
    expect(lint).toMatchObject({ status: "crashed", exitCode: 1 })
    expect(events.some((e) => e.type === "crashed" && e.proc.id === lint.id)).toBe(true)
  })

  it("supports the process actions", async () => {
    const { m, events } = setup()
    const id = m.getSnapshot().procs[0].id
    m.select(m.getSnapshot().procs[1].id)
    expect(m.getSnapshot().selectedId).toBe(m.getSnapshot().procs[1].id)

    const snap = await m.takeSnapshot(id)
    expect(snap!.entries.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === "snapshot")).toBe(true)
    expect(await m.takeSnapshot("nope")).toBeNull()

    const gcBefore = m.getSnapshot().procs[0].gc.length
    m.forceGc(id)
    expect(m.getSnapshot().procs[0].gc.length).toBe(gcBefore + 1)
    const worker = m.getSnapshot().procs.find((p) => p.command.startsWith("node worker"))!
    m.forceGc(worker.id)

    m.kill(id)
    const killed = m.getSnapshot().procs.find((p) => p.id === id)!
    expect(killed.status).toBe("exited")
    expect(killed.signal).toBe("SIGINT")

    m.restart(id)
    const fresh = m.getSnapshot().procs.find((p) => p.command === killed.command)!
    expect(fresh.id).not.toBe(id)
    expect(fresh.status).toBe("running")
    expect(m.getSnapshot().selectedId).toBe(fresh.id)
    m.restart("nope")

    m.select(fresh.id)
    m.remove(fresh.id)
    expect(m.getSnapshot().procs.some((p) => p.id === fresh.id)).toBe(false)
    const other = m.getSnapshot().procs[0].id
    m.select(other)
    m.remove(m.getSnapshot().procs[1].id)
    expect(m.getSnapshot().selectedId).toBe(other)

    m.clearEnded()
    expect(m.getSnapshot().procs.every((p) => p.status === "running")).toBe(true)
    // Clearing while the selection survives keeps it.
    m.select(m.getSnapshot().procs[0].id)
    m.clearEnded()
    expect(m.getSnapshot().selectedId).toBe(m.getSnapshot().procs[0].id)
  })

  it("actions while paused apply to the hidden state", async () => {
    const { m } = setup()
    m.setPaused(true)
    vi.advanceTimersByTime(TICK_MS)
    const id = m.getSnapshot().procs[0].id
    m.kill(id)
    expect(m.getSnapshot().procs.find((p) => p.id === id)!.status).toBe("exited")
    m.setPaused(false)
    expect(m.getSnapshot().procs.find((p) => p.id === id)!.status).toBe("exited")
  })

  it("leaves nothing selected when every process is removed", () => {
    const { m } = setup()
    m.clearEnded()
    for (const p of m.getSnapshot().procs) m.kill(p.id)
    m.clearEnded()
    expect(m.getSnapshot().procs).toEqual([])
    expect(m.getSnapshot().selectedId).toBeNull()
    m.remove("nope")
    expect(m.getSnapshot().selectedId).toBeNull()
  })

  it("caps histories and handles runtimes without a collector", async () => {
    const { m } = setup()
    const cargo = m.getSnapshot().procs.find((p) => p.command.startsWith("cargo"))!
    expect(cargo.samples.length).toBe(7200)
    const id = m.getSnapshot().procs[0].id
    for (let i = 0; i < 3010; i++) m.forceGc(id)
    expect(m.getSnapshot().procs[0].gc.length).toBe(3000)
    // A shell "worker" follows the sawtooth profile but has no GC to record.
    await m.capture("make worker", "")
    vi.advanceTimersByTime(TICK_MS * 120)
    const w = m.getSnapshot().procs.find((p) => p.command === "make worker")!
    expect(w.gc).toEqual([])
    // Snapshots work even for profiles without a "growing" type.
    await m.capture("make", "")
    const plain = m.getSnapshot().procs[0]
    expect((await m.takeSnapshot(plain.id))!.entries.length).toBeGreaterThan(0)
    expect((await m.takeSnapshot(w.id))!.entries.length).toBeGreaterThan(0)
  })

  it("selects nothing after removing the last selected process", () => {
    const { m } = setup()
    for (const p of m.getSnapshot().procs) m.kill(p.id)
    const ids = m.getSnapshot().procs.map((p) => p.id)
    for (const id of ids) {
      m.select(id)
      m.remove(id)
    }
    expect(m.getSnapshot().selectedId).toBeNull()
  })

  it("unsubscribes event listeners", () => {
    const { m, events, off } = setup()
    off()
    void m.capture("x", "")
    expect(events).toHaveLength(0)
  })
})
