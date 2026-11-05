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
