import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TimelineProvider } from "@/components/charts/timeline"
import { ResourcesTab } from "@/components/resources-tab"
import type { Proc } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 ** 2
const full = Array.from({ length: 30 }, (_, i) =>
  sample(1000 + i * 500, 100 * MiB, { threads: 4, files: 8, sockets: 2, pipes: 1, loopLag: 3 + i, kids: [{ pid: 7, rss: 30 * MiB, cpu: 1 }] }),
)

function show(over: Partial<Proc>, onJump = vi.fn()) {
  return render(
    <TimelineProvider proc={makeProc(over)} view={{ kind: "fixed", from: 1000, to: 16_000 }} setView={vi.fn()} onJump={onJump} axis="elapsed" paused>
      <ResourcesTab />
    </TimelineProvider>,
  )
}

describe("ResourcesTab", () => {
  it("shows measured series, ports and children, with tooltips that format each", async () => {
    const { container } = show({
      samples: full,
      childNames: { 7: "esbuild" },
      children: [{ pid: 7, name: "esbuild", cpu: 1, rss: 30 * MiB }],
      ports: [{ port: 3000, proto: "tcp", addr: "127.0.0.1", pid: 42 }],
    })
    expect(screen.getByText("3000")).toBeInTheDocument()
    expect(screen.getByText("127.0.0.1")).toBeInTheDocument()
    expect(screen.getAllByText("esbuild").length).toBeGreaterThan(0)
    const wrappers = container.querySelectorAll(".recharts-wrapper")
    expect(wrappers).toHaveLength(3)
    await act(() => new Promise((r) => setTimeout(r, 40)))
    wrappers.forEach((w) => fireEvent.mouseMove(w, { clientX: 400, clientY: 120 }))
    await act(() => new Promise((r) => setTimeout(r, 60)))
    expect(screen.getAllByText(/total 100 MiB/).length).toBeGreaterThan(0)
  })

  it("shows the zoom band on every chart while dragging", async () => {
    const onJump = vi.fn()
    const { container } = show({ samples: full }, onJump)
    const w = container.querySelector(".recharts-wrapper")!
    await act(() => new Promise((r) => setTimeout(r, 40)))
    fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
    await act(() => new Promise((r) => setTimeout(r, 60)))
    fireEvent.mouseDown(w, { clientX: 400, clientY: 120 })
    await act(() => new Promise((r) => setTimeout(r, 60)))
    expect(container.querySelectorAll(".recharts-reference-area").length).toBeGreaterThan(0)
    // Released without dragging, with no event nearby: the click's own time.
    fireEvent.mouseUp(w, { clientX: 400, clientY: 120 })
    expect(onJump.mock.calls[0][0]).toBeGreaterThanOrEqual(1000)
  })

  it("reports missing data as missing, not as measured zeros", () => {
    show({ samples: [sample(1000, 5), sample(1500, 6)], profiling: false })
    expect(screen.getByText(/No child processes seen/)).toBeInTheDocument()
    expect(screen.getByText(/didn't record thread or handle counts/)).toBeInTheDocument()
    expect(screen.getByText(/Not measured: lag needs a runtime agent/)).toBeInTheDocument()
    expect(screen.getByText("Not listening on any TCP port.")).toBeInTheDocument()
  })

  it("says when handle counts understate", () => {
    show({ samples: full, unavailable: ["fds"] })
    expect(screen.getByText(/understate them/)).toBeInTheDocument()
  })

  it("distinguishes waiting for an agent, and ended runs", () => {
    const { unmount } = show({ samples: [sample(1000, 5)], profiling: true })
    expect(screen.getByText(/Waiting for the runtime agent/)).toBeInTheDocument()
    unmount()
    show({ samples: [sample(1000, 5)], status: "exited", ports: [{ port: 1, proto: "tcp", addr: "a", pid: 1 }] })
    expect(screen.getByText("Ports are only known while the process runs.")).toBeInTheDocument()
    expect(screen.queryByText("a")).not.toBeInTheDocument()
  })
})
