import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CpuChart } from "@/components/charts/cpu-chart"
import { IoChart } from "@/components/charts/io-chart"
import { MemoryChart } from "@/components/charts/memory-chart"
import { TimelineProvider, useTimelineChart, visibleMax } from "@/components/charts/timeline"
import { MemoryTab } from "@/components/memory-tab"
import { TimeControls } from "@/components/time-controls"
import { RANGES, type AxisMode, type View } from "@/lib/series"
import { TICK_MS, type Proc } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

type Chart = ReturnType<typeof useTimelineChart>

/** Renders the hook the way a chart does, and hands back what it computed. */
function chartOf(proc: Proc, view: View, axis: AxisMode = "elapsed", paused = true, spies: { setView?: (v: View) => void; onJump?: (t: number) => void } = {}) {
  const out: { current?: Chart } = {}
  const Probe = () => {
    out.current = useTimelineChart()
    return null
  }
  render(
    <TimelineProvider proc={proc} view={view} setView={spies.setView ?? vi.fn()} onJump={spies.onJump ?? vi.fn()} axis={axis} paused={paused}>
      <Probe />
    </TimelineProvider>,
  )
  return out as { current: Chart }
}

const started = new Date(2026, 0, 1, 9, 0, 0).getTime()
const run = (n: number, status: Proc["status"] = "exited") =>
  makeProc({ status, startedAt: started, samples: Array.from({ length: n }, (_, i) => sample(started + i * TICK_MS, 100 + i)) })

describe("short chart windows", () => {
  it("labels a 1s axis in tenths, unrepeated, inside the exact window", () => {
    const { current: c } = chartOf(run(40), { kind: "live", range: "1s" })
    const end = started + 39 * TICK_MS
    expect([c.from, c.to]).toEqual([end - 1_000, end])
    expect(c.xAxis.domain).toEqual([end - 1_000, end])
    expect(c.xAxis.ticks).toEqual([end - 900, end - 700, end - 500, end - 300, end - 100])
    expect(c.xAxis.ticks.map(c.xAxis.tickFormatter)).toEqual(["0:18.6", "0:18.8", "0:19.0", "0:19.2", "0:19.4"])
    expect(c.timeLabel(end)).toBe("T+0:19.5  ·  09:00:19.5")
    expect(c.timeLabel(end - TICK_MS)).toBe("T+0:19.0  ·  09:00:19.0")
  })

  it("labels a 1s clock axis in tenths too", () => {
    const { current: c } = chartOf(run(40), { kind: "live", range: "1s" }, "clock")
    expect(c.xAxis.ticks.map(c.xAxis.tickFormatter)).toEqual(["09:00:18.6", "09:00:18.8", "09:00:19.0", "09:00:19.2", "09:00:19.4"])
  })

  it("keeps whole seconds on a 10s axis, with tooltips still telling samples apart", () => {
    const { current: c } = chartOf(run(40), { kind: "live", range: "10s" })
    const end = started + 39 * TICK_MS
    expect([c.from, c.to]).toEqual([end - 10_000, end])
    expect(c.xAxis.ticks.map(c.xAxis.tickFormatter)).toEqual(["0:10", "0:12", "0:14", "0:16", "0:18"])
    expect(c.timeLabel(end)).toBe("T+0:19.5  ·  09:00:19.5")
  })

  it("leaves longer ranges in whole seconds", () => {
    const { current: c } = chartOf(run(200), { kind: "live", range: "30s" })
    expect(c.timeLabel(started + 500)).toBe("T+0:01  ·  09:00:00")
    expect(c.xAxis.tickFormatter(started + 10_000)).toBe("0:10")
  })

  it("labels nothing before a run that is younger than the window", () => {
    const { current: c } = chartOf(run(3), { kind: "live", range: "10s" })
    expect(c.xAxis.ticks.every((t) => t >= started)).toBe(true)
    expect(c.from).toBe(started + 1_000 - 10_000)
    expect(c.xAxis.ticks.map(c.xAxis.tickFormatter)).toEqual(["0:00"])
  })

  it("gives every chart on the timeline the same range", () => {
    const proc = run(40)
    const domains: unknown[] = []
    const Probe = () => {
      const { xAxis, chart } = useTimelineChart()
      domains.push([xAxis.domain, xAxis.ticks, chart.syncId])
      return null
    }
    for (const range of ["1s", "10s"] as const) {
      domains.length = 0
      render(
        <TimelineProvider proc={proc} view={{ kind: "live", range }} setView={vi.fn()} onJump={vi.fn()} axis="elapsed" paused>
          <Probe />
          <Probe />
          <Probe />
        </TimelineProvider>,
      )
      expect(domains).toHaveLength(3)
      expect(new Set(domains.map((d) => JSON.stringify(d))).size).toBe(1)
    }
  })

  it("draws a point only when one sample is all there is", () => {
    expect(chartOf(run(1), { kind: "live", range: "1s" }).current.dot).toBe(true)
    expect(chartOf(run(2), { kind: "live", range: "1s" }).current.dot).toBe(false)
    const { container } = render(
      <TimelineProvider proc={run(1)} view={{ kind: "live", range: "1s" }} setView={vi.fn()} onJump={vi.fn()} axis="elapsed" paused>
        <CpuChart />
      </TimelineProvider>,
    )
    expect(container.querySelectorAll(".recharts-area-dot").length).toBeGreaterThan(0)
  })

  it("scales to the samples a line runs towards, even with none inside the window", () => {
    const data = [sample(0, 900), sample(5_000, 10), sample(10_000, 500), sample(15_000, 20)]
    // Only the sample at 5s and its neighbours can draw into this window.
    expect(visibleMax(data, 4_000, 6_000, ["rss"])).toBe(900)
    expect(visibleMax(data, 6_000, 7_000, ["rss"])).toBe(500)
    // Past the last sample: axes keep the last known scale.
    expect(visibleMax(data, 20_000, 21_000, ["rss"])).toBe(20)
    expect(visibleMax(data, -9_000, 16_000, ["rss"])).toBe(900)
    expect(visibleMax([], 0, 1, ["rss"])).toBe(0)
  })
})

describe("drag and click in short windows", () => {
  const frame = () => act(() => new Promise((r) => setTimeout(r, 60)))
  const drag = async (w: Element, a: number, b: number) => {
    fireEvent.mouseMove(w, { clientX: a, clientY: 120 })
    await frame()
    fireEvent.mouseDown(w, { clientX: a, clientY: 120 })
    await frame()
    fireEvent.mouseMove(w, { clientX: b, clientY: 120 })
    await frame()
    fireEvent.mouseUp(w, { clientX: b, clientY: 120 })
  }

  it.each([
    { range: "1s", least: TICK_MS },
    { range: "10s", least: 1_000 },
  ] as const)("zooms the $range window to the samples dragged across", async ({ range, least }) => {
    const proc = run(40)
    const setView = vi.fn()
    const end = proc.samples.at(-1)!.t
    const span = RANGES.find((r) => r.value === range)!.ms
    const { container } = render(
      <TimelineProvider proc={proc} view={{ kind: "live", range }} setView={setView} onJump={vi.fn()} axis="elapsed" paused>
        <IoChart />
      </TimelineProvider>,
    )
    await frame()
    await drag(container.querySelector(".recharts-wrapper")!, 100, 780)
    expect(setView).toHaveBeenCalledTimes(1)
    const zoom = setView.mock.calls[0][0]
    expect(zoom.kind).toBe("fixed")
    expect(zoom.to - zoom.from).toBeGreaterThanOrEqual(least)
    expect(zoom.from).toBeGreaterThanOrEqual(end - span)
    expect(zoom.to).toBeLessThanOrEqual(end)
    // It selected real samples rather than invented times.
    expect(proc.samples.map((s) => s.t)).toEqual(expect.arrayContaining([zoom.from, zoom.to]))
  })

  it("holds every linked chart still from press to release, then catches up", async () => {
    const t0 = Date.now()
    const samples = Array.from({ length: 40 }, (_, i) => sample(t0 - (39 - i) * TICK_MS, 100))
    const proc = makeProc({ status: "running", startedAt: samples[0].t, samples })
    const seen: Chart[] = []
    const Probe = () => {
      seen[0] = useTimelineChart()
      return null
    }
    const tree = (withChart: boolean, p = proc) => (
      <TimelineProvider proc={p} view={{ kind: "live", range: "1s" }} setView={vi.fn()} onJump={vi.fn()} axis="elapsed" paused={false}>
        <Probe />
        {withChart && <IoChart />}
      </TimelineProvider>
    )
    const { container, rerender } = render(tree(true))
    await frame()
    const w = container.querySelector(".recharts-wrapper")!
    fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
    await frame()
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await frame()
    const held = [seen[0].from, seen[0].to]
    const before = seen[0].data
    // A new sample and more time both arrive during the drag.
    rerender(tree(true, { ...proc, samples: [...samples, sample(t0 + 500, 999)] }))
    await frame()
    await frame()
    expect([seen[0].from, seen[0].to]).toEqual(held)
    expect(seen[0].data).toEqual(before)
    fireEvent.mouseUp(w, { clientX: 400, clientY: 120 })
    await frame()
    await frame()
    expect(seen[0].from).toBeGreaterThan(held[0])
    expect(seen[0].data.at(-1)!.rss).toBe(999)

    // Leaving the chart lets go too.
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await frame()
    const again = seen[0].from
    fireEvent.mouseLeave(w)
    await frame()
    await frame()
    expect(seen[0].from).toBeGreaterThan(again)

    // So does the chart disappearing mid-drag.
    fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
    await frame()
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await frame()
    const third = seen[0].from
    rerender(tree(false))
    await frame()
    await frame()
    expect(seen[0].from).toBeGreaterThan(third)
  })

  it("keeps a zoom inside the window when the pointer snaps to a sample beyond its edge", async () => {
    const end = started + 39 * TICK_MS
    const setView = vi.fn()
    const c = chartOf(run(40), { kind: "live", range: "1s" }, "elapsed", true, { setView })
    const event = (clientX: number) => ({ clientX }) as React.MouseEvent
    act(() => c.current.chart.onMouseDown({ activeLabel: end - 1_500 } as never, event(10)))
    act(() => c.current.chart.onMouseMove({ activeLabel: end + 500 } as never, event(700)))
    act(() => c.current.chart.onMouseUp({} as never, event(700)))
    expect(setView).toHaveBeenCalledWith({ kind: "fixed", from: end - 1_000, to: end })
  })

  it("treats a drag with no reading as having reached the window's edge", () => {
    const end = started + 39 * TICK_MS
    const setView = vi.fn()
    const c = chartOf(run(40), { kind: "live", range: "1s" }, "elapsed", true, { setView })
    const event = (clientX: number) => ({ clientX }) as React.MouseEvent
    act(() => c.current.chart.onMouseDown({ activeLabel: end - 500 } as never, event(400)))
    act(() => c.current.chart.onMouseMove({} as never, event(790)))
    act(() => c.current.chart.onMouseUp({} as never, event(790)))
    expect(setView).toHaveBeenLastCalledWith({ kind: "fixed", from: end - 500, to: end })
    act(() => c.current.chart.onMouseDown({ activeLabel: end - 500 } as never, event(400)))
    act(() => c.current.chart.onMouseMove({} as never, event(5)))
    act(() => c.current.chart.onMouseUp({} as never, event(5)))
    expect(setView).toHaveBeenLastCalledWith({ kind: "fixed", from: end - 1_000, to: end - 500 })
  })

  it("starts a drag at the first reading after a press that had none, and never without a press", () => {
    const end = started + 39 * TICK_MS
    const setView = vi.fn()
    const c = chartOf(run(40), { kind: "live", range: "1s" }, "elapsed", true, { setView })
    const event = (clientX: number) => ({ clientX }) as React.MouseEvent
    // Hovering, then releasing, selects nothing.
    act(() => c.current.chart.onMouseMove({ activeLabel: end - 900 } as never, event(100)))
    act(() => c.current.chart.onMouseUp({} as never, event(100)))
    expect(c.current.selection).toBeNull()
    expect(c.current.held).toBeNull()
    // The press has no reading but still stops the chart.
    act(() => c.current.chart.onMouseDown({} as never, event(100)))
    expect(c.current.held).not.toBeNull()
    expect(c.current.selection).toBeNull()
    act(() => c.current.chart.onMouseMove({} as never, event(110)))
    expect(c.current.selection).toBeNull()
    act(() => c.current.chart.onMouseMove({ activeLabel: end - 900 } as never, event(120)))
    act(() => c.current.chart.onMouseMove({ activeLabel: end - 100 } as never, event(700)))
    act(() => c.current.chart.onMouseUp({} as never, event(700)))
    expect(setView).toHaveBeenCalledWith({ kind: "fixed", from: end - 900, to: end - 100 })
    expect(c.current.held).toBeNull()
  })

  it("does not zoom a 10s window across a single sample interval", async () => {
    const setView = vi.fn()
    const { container } = render(
      <TimelineProvider proc={run(40)} view={{ kind: "live", range: "10s" }} setView={setView} onJump={vi.fn()} axis="elapsed" paused>
        <IoChart />
      </TimelineProvider>,
    )
    await frame()
    await drag(container.querySelector(".recharts-wrapper")!, 400, 440)
    expect(setView).not.toHaveBeenCalled()
  })

  it("snaps a click to an event within one sample at 1s", async () => {
    const proc = { ...run(40), logs: [{ id: 1, t: started + 19_200, stream: "stderr" as const, text: "boom" }] }
    const onJump = vi.fn()
    const { container } = render(
      <TimelineProvider proc={proc} view={{ kind: "live", range: "1s" }} setView={vi.fn()} onJump={onJump} axis="elapsed" paused>
        <IoChart />
      </TimelineProvider>,
    )
    await frame()
    const w = container.querySelector(".recharts-wrapper")!
    await drag(w, 400, 400)
    expect(onJump).toHaveBeenCalledWith(started + 19_200)
  })

  it("renders the memory chart at both presets on real samples", () => {
    for (const range of ["1s", "10s"] as const) {
      const { container, unmount } = render(
        <TimelineProvider proc={run(40)} view={{ kind: "live", range }} setView={vi.fn()} onJump={vi.fn()} axis="elapsed" paused>
          <MemoryChart />
        </TimelineProvider>,
      )
      expect(container.querySelector(".recharts-area-area")).toBeTruthy()
      unmount()
    }
  })
})

describe("time controls for short windows", () => {
  const controls = (view: View, live = true, setView = vi.fn()) => {
    render(<TimeControls view={view} setView={setView} axis="elapsed" setAxis={vi.fn()} lastRange="1m" live={live} />)
    return setView
  }

  it("offers 1s and 10s beside every existing range, and selects them", async () => {
    const setView = controls({ kind: "live", range: "1m" })
    expect(screen.getAllByRole("radiogroup")[0].textContent).toBe("1s10s30s1m5m15m1hAll")
    await userEvent.click(screen.getByRole("radio", { name: "1s" }))
    expect(setView).toHaveBeenLastCalledWith({ kind: "live", range: "1s" })
    await userEvent.click(screen.getByRole("radio", { name: "10s" }))
    expect(setView).toHaveBeenLastCalledWith({ kind: "live", range: "10s" })
    for (const name of ["30s", "1m", "5m", "15m", "1h", "All"]) expect(screen.getByRole("radio", { name })).toBeInTheDocument()
  })

  it("says why a live 1s window holds so few points", () => {
    controls({ kind: "live", range: "1s" })
    expect(screen.getByText(/Live · last 1s/)).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "1s" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText(`— one sample every ${TICK_MS}ms; drag across two to zoom`)).toBeInTheDocument()
  })

  it("doesn't claim a sample rate for a stored run or longer windows", () => {
    controls({ kind: "live", range: "1s" }, false)
    expect(screen.getByText(/Ended · last 1s/)).toBeInTheDocument()
    expect(screen.getByText("— drag across a chart to zoom")).toBeInTheDocument()
    controls({ kind: "live", range: "10s" })
    expect(screen.getByText(/Live · last 10s/)).toBeInTheDocument()
  })

  it("shows a short zoom's real length and ends", () => {
    const from = new Date(2026, 0, 1, 9, 0, 3, 500).getTime()
    controls({ kind: "fixed", from, to: from + 500 })
    expect(screen.getByRole("button", { name: /09:00:03\.5 – 09:00:04\.0/ })).toHaveTextContent("500ms")
  })

  it("keeps longer zooms as they were", () => {
    const from = new Date(2026, 0, 1, 9, 0, 3).getTime()
    controls({ kind: "fixed", from, to: from + 20_000 })
    expect(screen.getByRole("button", { name: /09:00:03 – 09:00:23/ })).toHaveTextContent("20s")
  })
})

describe("memory trend in short windows", () => {
  const show = (range: "1s" | "10s", proc: Proc) =>
    render(
      <TimelineProvider proc={proc} view={{ kind: "live", range }} setView={vi.fn()} onJump={vi.fn()} axis="elapsed" paused>
        <MemoryTab totalMemory={1024 ** 3} />
      </TimelineProvider>,
    )

  it("won't call three samples a trend", () => {
    show("1s", run(40))
    expect(screen.getByText("Too few samples.")).toBeInTheDocument()
    expect(screen.getByText(/holds 3 of the 10 samples/)).toBeInTheDocument()
    expect(screen.queryByText(/^R²/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Stable|Growing|Oscillating/)).not.toBeInTheDocument()
  })

  it("reports a trend once the 10s window has enough", () => {
    show("10s", run(40))
    expect(screen.queryByText("Too few samples.")).not.toBeInTheDocument()
    expect(screen.getByText(/^R²/)).toBeInTheDocument()
  })
})

describe("live advancement through the rendered hook", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame", "performance"] }))
  afterEach(() => vi.useRealTimers())

  it.each([
    { range: "1s", span: 1_000 },
    { range: "10s", span: 10_000 },
  ] as const)("moves the $range window and its ticks with time", ({ range, span }) => {
    const now = Date.now()
    const samples = Array.from({ length: 60 }, (_, i) => sample(now - (59 - i) * TICK_MS, 100))
    const proc = makeProc({ status: "running", startedAt: samples[0].t, samples })
    const out = chartOf(proc, { kind: "live", range }, "clock", false)
    const first = out.current
    expect(first.to - first.from).toBe(span)
    act(() => vi.advanceTimersByTime(span))
    const later = out.current
    expect(later.to - later.from).toBe(span)
    expect(Date.now() - TICK_MS * 1.5 - later.to).toBeLessThanOrEqual(34)
    expect(later.from).toBeGreaterThan(first.from)
    expect(later.xAxis.ticks.every((t) => t >= later.from && t <= later.to)).toBe(true)
    expect(later.xAxis.ticks[0]).toBeGreaterThan(first.xAxis.ticks[0])
  })
})
