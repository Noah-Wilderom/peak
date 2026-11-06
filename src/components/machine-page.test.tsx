import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { MachinePage } from "@/components/machine-page"
import { MachineStrip } from "@/components/machine-strip"
import type { SystemSample } from "@/lib/types"
import { makeProc, sample } from "@/test/fixtures"

const GiB = 1024 ** 3
const sys = (t: number, over: Partial<SystemSample> = {}): SystemSample => ({
  t, memTotal: 32 * GiB, memAvailable: 22 * GiB, swapTotal: 8 * GiB, swapFree: 8 * GiB, psiSome: 1.5, psiFull: 0.5, load1: 2.25, cpu: 10, ...over,
})
const system = { totalMemory: 32 * GiB, cpus: 12, hostname: "devbox", os: "linux" }

describe("MachineStrip", () => {
  it("summarizes the host and opens the details", async () => {
    const onOpen = vi.fn()
    const { rerender } = render(<MachineStrip sample={sys(1)} active={false} onOpen={onOpen} />)
    expect(screen.getByText("10 GiB of 32 GiB")).toBeInTheDocument()
    expect(screen.getByText("Load 2.25")).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: /This machine/ }))
    expect(onOpen).toHaveBeenCalled()
    rerender(<MachineStrip sample={sys(1, { memAvailable: GiB })} active onOpen={onOpen} />)
    expect(screen.getByText("31 GiB of 32 GiB")).toHaveClass("text-warning")
    rerender(<MachineStrip sample={sys(1, { memTotal: 0, memAvailable: 0 })} active onOpen={onOpen} />)
    expect(screen.getByText("0 B of 0 B")).toBeInTheDocument()
  })
})

describe("MachinePage", () => {
  it("labels host figures and separates them from the selected process", async () => {
    const onClose = vi.fn()
    const proc = makeProc({ samples: [sample(1000, GiB), sample(1500, 2 * GiB)] })
    const many = Array.from({ length: 12 }, (_, i) => sys(1000 + i * 500))
    const { container } = render(<MachinePage samples={many} system={system} proc={proc} onClose={onClose} />)
    expect(screen.getByText(/devbox · 12 CPUs/)).toBeInTheDocument()
    expect(screen.getByText("The machine has room.")).toBeInTheDocument()
    expect(screen.getByText(/holds 2 GiB, 6.3% of the machine/)).toBeInTheDocument()
    expect(screen.getByText("100% is all 12 CPUs · load 2.25")).toBeInTheDocument()
    for (const w of container.querySelectorAll(".recharts-wrapper")) {
      await act(() => new Promise((r) => setTimeout(r, 40)))
      fireEvent.mouseMove(w, { clientX: 400, clientY: 120 })
      await act(() => new Promise((r) => setTimeout(r, 60)))
    }
    expect(screen.getAllByText("Machine in use").length).toBeGreaterThan(1)
    expect(screen.getAllByText("Machine CPU").length).toBeGreaterThan(1)
    await userEvent.setup().click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("says what isn't known or configured, and when the host itself is short", () => {
    render(
      <MachinePage
        samples={[sys(1000, { swapTotal: 0, swapFree: 0, psiSome: null, psiFull: null, memAvailable: GiB })]}
        system={{ ...system, hostname: "" }}
        proc={makeProc({ status: "exited" })}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("No swap")).toBeInTheDocument()
    expect(screen.getByText("Not reported")).toBeInTheDocument()
    expect(screen.getByText("The machine is short on memory.")).toBeInTheDocument()
    expect(screen.queryByText(/holds/), "an ended process holds nothing").not.toBeInTheDocument()
    expect(screen.getByText(/This host · 12 CPUs/)).toBeInTheDocument()
  })

  it("handles unknown capacity and partial pressure, and waits for the first sample", () => {
    const { rerender } = render(<MachinePage samples={[]} system={system} proc={null} onClose={vi.fn()} />)
    expect(screen.getByText("No machine samples yet.")).toBeInTheDocument()
    rerender(<MachinePage samples={[sys(1, { memTotal: 0, memAvailable: 0, psiFull: null })]} system={system} proc={makeProc()} onClose={vi.fn()} />)
    expect(screen.queryByText(/holds/)).not.toBeInTheDocument()
    expect(screen.getByText("0.0% of tasks fully stalled")).toBeInTheDocument()
    rerender(<MachinePage samples={[sys(1)]} system={system} proc={null} onClose={vi.fn()} />)
    expect(screen.queryByText(/holds/)).not.toBeInTheDocument()
  })
})
