import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MockMonitor, type MonitorEvent } from "@/lib/mock"
import { TICK_MS } from "@/lib/types"

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
