import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ErrorBoundary } from "@/components/error-boundary"
import { buildStats } from "@/components/stats-tab"
import { layoutFlame } from "@/components/flame-graph"
import { StatusPill, statusLabel } from "@/components/status"
import { CapturePage } from "@/components/capture-page"
import { ProfilerTab } from "@/components/profiler-tab"
import { monitor } from "@/lib/monitor"
import { makeProc, sample } from "@/test/fixtures"

const system = { totalMemory: 1024, cpus: 4, hostname: "h", os: "linux" }

function Boom({ fail }: { fail: boolean }): React.ReactNode {
  if (fail) throw new Error("kaboom")
  return <p>fine</p>
}

describe("ErrorBoundary", () => {
  it("contains render errors and recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup()
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Boom fail />
      </ErrorBoundary>,
    )
    expect(screen.getByText("kaboom")).toBeInTheDocument()
    rerender(
      <ErrorBoundary resetKey="a">
        <Boom fail={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText("kaboom")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByText("fine")).toBeInTheDocument()
    rerender(
      <ErrorBoundary resetKey="a">
        <Boom fail />
      </ErrorBoundary>,
    )
    rerender(
      <ErrorBoundary resetKey="b">
        <Boom fail={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText("fine")).toBeInTheDocument()
  })
})

describe("status", () => {
  it("labels every ending", () => {
    expect(statusLabel(makeProc())).toBe("Running")
    expect(statusLabel(makeProc({ status: "crashed", signal: "SIGSEGV" }))).toBe("Killed · SIGSEGV")
    expect(statusLabel(makeProc({ status: "crashed", exitCode: 2 }))).toBe("Failed · exit 2")
    expect(statusLabel(makeProc({ status: "exited", signal: "SIGINT" }))).toBe("Stopped · SIGINT")
    expect(statusLabel(makeProc({ status: "exited", exitCode: 0 }))).toBe("Exited · 0")
    render(<StatusPill proc={makeProc({ status: "crashed", exitCode: 1 })} />)
    expect(screen.getByText("Failed · exit 1")).toBeInTheDocument()
  })
})

describe("buildStats", () => {
  it("reports everything, with fallbacks for missing data", () => {
    const rust = makeProc({ runtime: "rust", hasGc: false, status: "exited", exitCode: 0, endedAt: 5000 })
    const groups = buildStats(rust, system)
    const rows = Object.fromEntries(groups.flatMap((g) => g.rows))
    expect(rows["Collector"]).toBe("None — ownership-based")
    expect(rows["State"]).toBe("exited (code 0)")
    expect(rows["Ran for"]).toBe("4s")
    expect(rows["Resident (RSS)"]).toBe("—")
    expect(rows["User / system split"]).toBe("—")
    expect(rows["System calls"]).toBe("—")
    const busy = makeProc({
      status: "crashed", exitCode: 1, signal: "SIGKILL",
      counters: { ...makeProc().counters, cpuUserMs: 750, cpuSysMs: 250, syscalls: 12 },
      gc: [{ t: 1200, kind: "major", pauseMs: 4, freed: 1024 }],
    })
    const r2 = Object.fromEntries(buildStats(busy, system).flatMap((g) => g.rows))
    expect(r2["State"]).toBe("crashed (code 1, SIGKILL)")
    expect(r2["User / system split"]).toBe("75% / 25%")
    expect(r2["Collections"]).toBe("1 (1 major)")
    expect(r2["System calls"]).toBe("12")
    const running = Object.fromEntries(buildStats(makeProc(), system).flatMap((g) => g.rows))
    expect(running["Uptime"]).toBeDefined()
    expect(running["Threads"]).toBe("4")
  })
})

describe("buildStats for remote and unreadable data", () => {
  const target = { targetId: "t", label: "box", kind: "kubernetes" as const, launched: true, clockOffsetMs: -1200, identity: { bootId: "b", pidNs: "n", pid: 7, startTicks: 3, containerId: "cid", podUid: "uid" } }
  const rows = (p: Parameters<typeof buildStats>[0]) => Object.fromEntries(buildStats(p, system).flatMap((g) => g.rows.map(([k, v]) => [k, v])))

  it("shows identity, clocks and gaps for a remote run", () => {
    const r = rows(makeProc({ target, gaps: [{ from: 1, to: 2 }] }))
    expect(r["Where"]).toBe("box (kubernetes)")
    expect(r["How"]).toBe("Launched by peak")
    expect(r["PID in its namespace"]).toBe("7")
    expect(r["Container"]).toBe("cid")
    expect(r["Pod"]).toBe("uid")
    expect(r["This machine's clock vs the target's"]).toBe("−1.2s")
    expect(r["Gaps in data"]).toBe("1")
    expect(r["Share of the target's host memory"]).toBeDefined()
    const bare = rows(makeProc({ target: { ...target, launched: false, clockOffsetMs: 5, identity: { bootId: "b", pidNs: "n", pid: 7, startTicks: 3 } } }))
    expect(bare["How"]).toMatch(/only observed/)
    expect(bare["Container"]).toBeUndefined()
    expect(bare["Gaps in data"]).toBe("0")
    expect(bare["This machine's clock vs the target's"]).toBe("+5ms")
    expect(rows(makeProc())["Where"]).toBeUndefined()
  })

  it("marks unreadable metrics instead of printing zeros", () => {
    const r = rows(makeProc({ unavailable: ["io", "fds"] }))
    for (const k of ["Total read", "Total written", "Average read rate", "Peak write rate", "Open files", "Sockets", "Pipes"]) expect(r[k]).toBe("Unavailable")
    const ok = rows(makeProc())
    expect(ok["Total read"]).toBe("0 B")
    expect(ok["Open files"]).toBe("1")
  })
})

describe("layoutFlame", () => {
  const root = {
    name: "(root)", self: 0, children: [
      { name: "a", self: 10, children: [{ name: "b", self: 30, children: [] }] },
      { name: "c", self: 60, children: [] },
    ],
  }
  it("lays frames out by size and supports zooming", () => {
    const full = layoutFlame(root, [])
    expect(full.depth).toBe(3)
    const c = full.cells.find((x) => x.frame.name === "c")!
    expect(c.x).toBe(0) // biggest first
    expect(c.w).toBe(0.6)
    const zoomed = layoutFlame(root, ["a"])
    expect(zoomed.cells[0]).toMatchObject({ key: "a-0", w: 1 })
    expect(zoomed.cells.find((x) => x.frame.name === "b")!.w).toBe(0.75)
    // Unknown path segments stop the descent.
    expect(layoutFlame(root, ["nope"]).cells[0].frame.name).toBe("(root)")
    expect(layoutFlame({ name: "(root)", self: 0, children: [] }, []).focusTotal).toBe(1)
  })
})

describe("CapturePage", () => {
  it("ignores empty submits and shows processes without a cwd", async () => {
    const user = userEvent.setup()
    vi.spyOn(monitor, "listAttachable").mockResolvedValue([{ pid: 7, command: "orphan", cwd: "", rss: 1 }])
    const capture = vi.spyOn(monitor, "capture")
    render(<CapturePage />)
    await user.type(screen.getByPlaceholderText("bun run build"), "{enter}")
    expect(capture).not.toHaveBeenCalled()
    expect(await screen.findByText("orphan")).toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
  })
})

describe("ProfilerTab", () => {
  it("handles empty and stale snapshot selections", async () => {
    const user = userEvent.setup()
    const proc = makeProc({ snapshots: [] })
    const { rerender } = render(<ProfilerTab proc={proc} />)
    expect(screen.getByText("No snapshot selected.")).toBeInTheDocument()
    expect(screen.getByText("No snapshots yet.")).toBeInTheDocument()
    const snap = (id: string, heapUsed: number) => ({
      id, t: 1500, heapUsed, entries: [{ name: "Object", count: 1, shallow: heapUsed, retained: heapUsed }],
      sites: { name: "(root)", self: heapUsed, children: [] },
    })
    vi.spyOn(monitor, "takeSnapshot").mockResolvedValue(null)
    await user.click(screen.getByRole("button", { name: /Take snapshot/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: /Take snapshot/ })).toBeEnabled())
    rerender(<ProfilerTab proc={{ ...proc, snapshots: [snap("s1", 200), snap("s2", 100)] }} />)
    expect(screen.getByText("None notable")).toBeInTheDocument()
    expect(screen.getByText("−100 B vs snapshot 1")).toBeInTheDocument()
    await user.click(screen.getAllByText("Snapshot 1")[0])
    rerender(<ProfilerTab proc={{ ...proc, snapshots: [snap("s3", 10)], status: "exited" }} />)
    expect(screen.getAllByText("Snapshot 1").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: /Take snapshot/ })).toBeDisabled()
    act(() => {})
    void sample
  })
})

describe("Bytes hover card", () => {
  it("shows every unit and stays live while open", async () => {
    const { Bytes } = await import("@/components/bytes")
    const user = userEvent.setup({ delay: null })
    const { rerender } = render(<Bytes value={2048} rate />)
    await user.hover(screen.getByText(/KiB/))
    expect(await screen.findByText("Bytes/s")).toBeInTheDocument()
    expect(screen.getByText("2,048")).toBeInTheDocument()
    rerender(<Bytes value={4096} rate />)
    expect(await screen.findByText("4,096")).toBeInTheDocument()
    rerender(<Bytes value={10}>custom</Bytes>)
    expect(screen.getByText("custom")).toBeInTheDocument()
  })
})

describe("CopyPid", () => {
  it("copies, confirms and reports failures", async () => {
    const { CopyPid } = await import("@/components/copy-pid")
    const { Toaster } = await import("@/components/ui/sonner")
    const user = userEvent.setup({ delay: null })
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(
      <>
        <CopyPid pid={77} />
        <Toaster />
      </>,
    )
    await user.click(screen.getByRole("button", { name: "Copy PID 77" }))
    expect(writeText).toHaveBeenCalledWith("77")
    await waitFor(() => expect(document.querySelector(".text-success")).toBeTruthy())
    await waitFor(() => expect(document.querySelector(".text-success")).toBeFalsy(), { timeout: 3000 })
    await user.click(screen.getByRole("button", { name: "Copy PID 77" }))
    expect(await screen.findByText("Couldn't copy PID")).toBeInTheDocument()
  })
})

describe("memory detail charts", () => {
  it("renders GC, distribution and treemap tooltips", async () => {
    const { fireEvent } = await import("@testing-library/react")
    const { TimelineProvider } = await import("@/components/charts/timeline")
    const { GcChart, DistributionChart } = await import("@/components/charts/memory-detail-charts")
    const { HeapTreemap } = await import("@/components/charts/heap-treemap")
    const samples = Array.from({ length: 60 }, (_, i) => sample(1000 + i * 500, 100 + (i % 7) * 10))
    const proc = makeProc({
      samples,
      gc: [
        { t: 5000, kind: "minor", pauseMs: 1, freed: 100 },
        { t: 9000, kind: "major", pauseMs: 12, freed: 9000 },
      ],
    })
    const { container } = render(
      <TimelineProvider proc={proc} view={{ kind: "fixed", from: 1000, to: 30500 }} setView={() => {}} onJump={() => {}} axis="elapsed" paused>
        <GcChart />
        <DistributionChart samples={samples} />
        <HeapTreemap entries={[{ name: "Object", count: 3, shallow: 30, retained: 40, delta: 10 }, { name: "Map", count: 1, shallow: 5, retained: 5, delta: -2 }]} />
      </TimelineProvider>,
    )
    const frame = () => act(() => new Promise((r) => setTimeout(r, 60)))
    for (const sym of container.querySelectorAll(".recharts-scatter-symbol")) {
      fireEvent.mouseEnter(sym)
      await frame()
    }
    expect(screen.getAllByText(/Major|Minor/).length).toBeGreaterThan(0)
    const dist = container.querySelectorAll(".recharts-wrapper")[1]
    fireEvent.mouseMove(dist, { clientX: 300, clientY: 150 })
    await frame()
    fireEvent.mouseMove(dist, { clientX: 320, clientY: 150 })
    await frame()
    expect(screen.getAllByText("Time spent").length).toBeGreaterThan(0)
    const cell = container.querySelector(".recharts-treemap-depth-1")
    if (cell) {
      fireEvent.mouseEnter(cell)
      await frame()
    }
  })
})

describe("edge cases", () => {
  it("notifies for every event type", async () => {
    const { notify } = await import("@/App")
    const { toast } = await import("sonner")
    const spies = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error")]
    const base = makeProc()
    notify({ type: "captured", proc: base })
    notify({ type: "exited", proc: base })
    notify({ type: "crashed", proc: makeProc({ exitCode: 1 }) })
    notify({ type: "crashed", proc: makeProc({ signal: "SIGSEGV" }) })
    notify({ type: "snapshot", proc: base, snapshot: { id: "s", t: 1, heapUsed: 1, entries: [], sites: { name: "(root)", self: 0, children: [] } } })
    expect(spies[0]).toHaveBeenCalledTimes(1)
    expect(spies[1]).toHaveBeenCalledWith(expect.any(String), { description: expect.stringContaining("exit 1") })
    expect(spies[1]).toHaveBeenCalledWith(expect.any(String), { description: expect.stringContaining("SIGSEGV") })
  })

  it("renders empty windows and empty trees", async () => {
    const { TimelineProvider } = await import("@/components/charts/timeline")
    const { MemoryTab } = await import("@/components/memory-tab")
    const { FlameGraph } = await import("@/components/flame-graph")
    const zero = sample(1000, 0, { heap: 0, heapTotal: 0, external: 0, code: 0, stack: 0 })
    const proc = makeProc({ samples: [zero], peak: zero })
    render(
      <TimelineProvider proc={proc} view={{ kind: "fixed", from: 50_000, to: 60_000 }} setView={() => {}} onJump={() => {}} axis="clock" paused>
        <MemoryTab totalMemory={1024} />
      </TimelineProvider>,
    )
    expect(screen.getByText("Too few samples.")).toBeInTheDocument()
    expect(screen.getByText(/holds 0 of the 10 samples/)).toBeInTheDocument()
    render(<FlameGraph root={{ name: "(root)", self: 0, children: [{ name: "tiny", self: 0, children: [] }] }} />)
    render(<FlameGraph root={{ name: "(root)", self: 100, children: [{ name: "speck", file: "a.js:1", self: 1, children: [] }] }} />)
    expect(screen.queryByText("speck")).not.toBeInTheDocument() // too narrow to label
  })

  it("marks new types in the diff and guards double submits", async () => {
    const snap = (id: string, names: string[]) => ({
      id, t: 1500, heapUsed: 100,
      entries: names.map((name) => ({ name, count: 1, shallow: 50, retained: 50 })),
      sites: { name: "(root)", self: 100, children: [] },
    })
    render(<ProfilerTab proc={makeProc({ snapshots: [snap("a", ["Object"]), snap("b", ["Object", "Brand"])] })} />)
    expect(screen.getByText("new")).toBeInTheDocument()

    const user = userEvent.setup({ delay: null })
    let resolve!: () => void
    const capture = vi.spyOn(monitor, "capture").mockImplementation(() => new Promise<void>((r) => (resolve = r)))
    vi.spyOn(monitor, "listAttachable").mockResolvedValue([])
    render(<CapturePage />)
    await user.type(screen.getByPlaceholderText("bun run build"), "sleep 1{enter}{enter}")
    expect(capture).toHaveBeenCalledTimes(1)
    await act(async () => resolve())
  })

  it("shows the treemap tooltip", async () => {
    const { HeapTreemap, TreemapTooltip } = await import("@/components/charts/heap-treemap")
    render(<HeapTreemap entries={[{ name: "Object", count: 3, shallow: 30, retained: 40, delta: 10 }]} />)
    const entry = { name: "Map", count: 1, shallow: 5, retained: 5, delta: -2 }
    const { rerender } = render(<TreemapTooltip active payload={[{ payload: entry }]} />)
    expect(screen.getByText("Retained size")).toBeInTheDocument()
    expect(screen.getByText("−2 B")).toBeInTheDocument()
    rerender(<TreemapTooltip active payload={[{ payload: { ...entry, delta: 4 } }]} />)
    expect(screen.getByText("+4 B")).toBeInTheDocument()
    rerender(<TreemapTooltip active={false} payload={[]} />)
    expect(screen.queryByText("Retained size")).not.toBeInTheDocument()
    rerender(<TreemapTooltip active />)
  })
})

describe("timeline charts", () => {
  it("treats a click as a jump, snapping to an event it was aimed at", async () => {
    const { fireEvent } = await import("@testing-library/react")
    const { TimelineProvider } = await import("@/components/charts/timeline")
    const { AllocChart } = await import("@/components/charts/memory-detail-charts")
    const samples = Array.from({ length: 60 }, (_, i) => sample(1000 + i * 500, 100 + i))
    const gc = samples.map((s) => ({ t: s.t + 50, kind: "major" as const, pauseMs: 1, freed: 1 }))
    const onJump = vi.fn()
    const { container } = render(
      <TimelineProvider proc={makeProc({ samples, gc })} view={{ kind: "fixed", from: 1000, to: 30500 }} setView={vi.fn()} onJump={onJump} axis="clock" paused>
        <AllocChart />
      </TimelineProvider>,
    )
    const frame = () => act(() => new Promise((r) => setTimeout(r, 60)))
    await frame()
    const w = container.querySelector(".recharts-wrapper")!
    fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
    await frame()
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await frame()
    fireEvent.mouseUp(w, { clientX: 400, clientY: 120 })
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(gc.map((g) => g.t)).toContain(onJump.mock.calls[0][0])

    // Across too little data to zoom, the pointer still moved: neither zoom nor click.
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await frame()
    fireEvent.mouseUp(w, { clientX: 460, clientY: 120 })
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it("renders every tooltip and ignores stray pointer events", async () => {
    const { fireEvent } = await import("@testing-library/react")
    const { TimelineProvider, useTimeline } = await import("@/components/charts/timeline")
    const { CompositionChart, AllocChart, FaultsChart } = await import("@/components/charts/memory-detail-charts")
    const samples = Array.from({ length: 60 }, (_, i) => sample(1000 + i * 500, 100 + i))
    const proc = makeProc({ samples })
    const setView = vi.fn()
    const onJump = vi.fn()
    const { container } = render(
      <TimelineProvider proc={proc} view={{ kind: "fixed", from: 1000, to: 30500 }} setView={setView} onJump={onJump} axis="clock" paused>
        <CompositionChart />
        <AllocChart />
        <FaultsChart />
      </TimelineProvider>,
    )
    const frame = () => act(() => new Promise((r) => setTimeout(r, 60)))
    await frame()
    for (const w of container.querySelectorAll(".recharts-wrapper")) {
      // Mouse-up without a drag, and mouse-down outside the plot, do nothing.
      fireEvent.mouseUp(w)
      fireEvent.mouseDown(w, { clientX: 2, clientY: 2 })
      fireEvent.mouseLeave(w)
      fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
      await frame()
    }
    // Drag across the composition chart.
    const comp = container.querySelector(".recharts-wrapper")!
    fireEvent.mouseMove(comp, { clientX: 150, clientY: 120 })
    await frame()
    fireEvent.mouseDown(comp, { clientX: 150, clientY: 120 })
    await frame()
    fireEvent.mouseMove(comp, { clientX: 600, clientY: 120 })
    await frame()
    fireEvent.mouseUp(comp)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ kind: "fixed" }))
    setView.mockClear()
    expect(screen.getAllByText("Allocated").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Minor faults/s").length).toBeGreaterThan(0)
    expect(setView).not.toHaveBeenCalled()
    vi.spyOn(console, "error").mockImplementation(() => {})
    function Orphan() {
      useTimeline()
      return null
    }
    expect(() => render(<Orphan />)).toThrow(/TimelineProvider/)
  })
})

describe("App states", () => {
  it("waits for the backend and surfaces its errors", async () => {
    const { default: App } = await import("@/App")
    const snap = monitor.getSnapshot()
    const spy = vi.spyOn(monitor, "getSnapshot").mockReturnValue({ ...snap, ready: false })
    const { unmount } = render(<App />)
    expect(screen.queryByText("Capture a process.")).not.toBeInTheDocument()
    unmount()
    spy.mockReturnValue({ ...snap, error: "backend exploded" })
    render(<App />)
    expect(await screen.findByText("Backend error")).toBeInTheDocument()
  })
})
