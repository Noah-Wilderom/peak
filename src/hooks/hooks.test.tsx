import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTimeDomain, useTweened } from "@/hooks/use-smooth"
import { useMonitor, useMonitorEvents } from "@/hooks/use-monitor"
import { monitor } from "@/lib/monitor"
import { makeProc, sample } from "@/test/fixtures"
import { TICK_MS } from "@/lib/types"

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame", "performance"] }))
afterEach(() => vi.useRealTimers())

describe("useTimeDomain", () => {
  const now = () => Date.now()

  it("glides with wall-clock time while live", () => {
    const t0 = now()
    const proc = makeProc({ startedAt: t0 - 60_000, samples: [sample(t0 - 60_000, 1), sample(t0, 1)] })
    const { result } = renderHook(() => useTimeDomain(proc, { kind: "live", range: "30s" }, false))
    const [, end0] = result.current
    expect(end0 - result.current[0]).toBe(30_000)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current[1]).toBeGreaterThan(end0)
    expect(result.current[1]).toBeLessThanOrEqual(now() - TICK_MS * 1.5 + 1)
  })

  it("never starts before the first sample", () => {
    const t0 = now()
    const proc = makeProc({ startedAt: t0, samples: [sample(t0, 1)] })
    const { result } = renderHook(() => useTimeDomain(proc, { kind: "live", range: "30s" }, false))
    expect(result.current[1]).toBe(t0)
  })

  it("stops when paused, ended or fixed", () => {
    const t0 = now()
    const proc = makeProc({ samples: [sample(t0 - 1000, 1), sample(t0, 1)] })
    const paused = renderHook(() => useTimeDomain(proc, { kind: "live", range: "1m" }, true))
    expect(paused.result.current).toEqual([t0 - 60_000, t0])
    const fixed = renderHook(() => useTimeDomain(proc, { kind: "fixed", from: 5, to: 10 }, false))
    expect(fixed.result.current).toEqual([5, 10])
    const ended = renderHook(() => useTimeDomain({ ...proc, status: "exited" }, { kind: "live", range: "all" }, false))
    expect(ended.result.current[1]).toBe(t0)
  })

  describe.each([
    { range: "1s", span: 1_000 },
    { range: "10s", span: 10_000 },
  ] as const)("in the $range window", ({ range, span }) => {
    const view = { kind: "live", range } as const

    it("keeps its exact span while following the clock frame by frame", () => {
      const t0 = now()
      const proc = makeProc({ startedAt: t0 - 60_000, samples: [sample(t0 - 60_000, 1), sample(t0, 1)] })
      const { result } = renderHook(() => useTimeDomain(proc, view, false))
      expect(result.current).toEqual([t0 - TICK_MS * 1.5 - span, t0 - TICK_MS * 1.5])
      const seen = [result.current[1]]
      for (let i = 0; i < 3; i++) {
        act(() => vi.advanceTimersByTime(100))
        const [from, to] = result.current
        expect(to - from).toBe(span)
        // Within one redraw of the clock.
        expect(now() - TICK_MS * 1.5 - to).toBeLessThanOrEqual(34)
        seen.push(to)
      }
      expect(new Set(seen).size).toBe(seen.length)
    })

    it("starts at the first sample, then advances past it", () => {
      const t0 = now()
      const proc = makeProc({ startedAt: t0, samples: [sample(t0, 1)] })
      const { result } = renderHook(() => useTimeDomain(proc, view, false))
      expect(result.current).toEqual([t0 - span, t0])
      act(() => vi.advanceTimersByTime(TICK_MS * 3))
      expect(now() - TICK_MS * 1.5 - result.current[1]).toBeLessThanOrEqual(34)
      expect(result.current[1]).toBeGreaterThan(t0)
    })

    it("freezes on the last sample when paused or ended, so stored runs show their end", () => {
      const t0 = now()
      const proc = makeProc({ samples: [sample(t0 - 20_000, 1), sample(t0 - 5_000, 1)] })
      const paused = renderHook(() => useTimeDomain(proc, view, true))
      const ended = renderHook(() => useTimeDomain({ ...proc, status: "exited" }, view, false))
      act(() => vi.advanceTimersByTime(500))
      expect(paused.result.current).toEqual([t0 - 5_000 - span, t0 - 5_000])
      expect(ended.result.current).toEqual([t0 - 5_000 - span, t0 - 5_000])
    })
  })

  it("moves every chart mounted at any time in the same frame", () => {
    const t0 = now()
    const proc = makeProc({ startedAt: t0 - 60_000, samples: [sample(t0 - 60_000, 1), sample(t0, 1)] })
    const view = { kind: "live", range: "1s" } as const
    const a = renderHook(() => useTimeDomain(proc, view, false))
    act(() => vi.advanceTimersByTime(47))
    const b = renderHook(() => useTimeDomain(proc, view, false))
    for (let i = 0; i < 12; i++) {
      act(() => vi.advanceTimersByTime(16))
      if (i > 2) expect(b.result.current).toEqual(a.result.current)
    }
  })

  it("shares one animation loop between charts", () => {
    const t0 = now()
    const proc = makeProc({ samples: [sample(t0 - 1000, 1), sample(t0, 1)] })
    const a = renderHook(() => useTimeDomain(proc, { kind: "live", range: "30s" }, false))
    const b = renderHook(() => useTimeDomain(proc, { kind: "live", range: "1h" }, false))
    act(() => vi.advanceTimersByTime(100))
    a.unmount()
    b.unmount()
    // The loop notices it has no subscribers left and stops scheduling frames.
    act(() => {
      vi.advanceTimersToNextFrame()
      vi.advanceTimersToNextFrame()
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("useTweened", () => {
  it("eases toward new targets", () => {
    const { result, rerender } = renderHook(({ v }) => useTweened(v, 0.2), { initialProps: { v: 0 } })
    expect(result.current).toBe(0)
    rerender({ v: 100 })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(100)
  })
})

describe("useMonitor", () => {
  it("reads the store and forwards events", async () => {
    const { result } = renderHook(() => useMonitor())
    expect(result.current.ready).toBe(true)
    const handler = vi.fn()
    renderHook(() => useMonitorEvents(handler))
    await act(() => monitor.capture("node server.js", "~"))
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "captured" }))
  })
})
