import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ComparePage } from "@/components/compare-page"
import { monitor } from "@/lib/monitor"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 ** 2
const ids: [string, string] = ["a", "b"]

function setup(a = makeProc({ id: "a" }), b = makeProc({ id: "b" })) {
  const load = vi.spyOn(monitor, "loadRun").mockImplementation(async (id) => (id === "a" ? a : b))
  const onBack = vi.fn()
  const view = render(<ComparePage ids={ids} onBack={onBack} />)
  return { ...view, load, onBack, user: userEvent.setup() }
}

describe("ComparePage", () => {
  it("shows both runs with differences and units", async () => {
    const before = monitor.getSnapshot().procs.length
    const samplesA = [sample(1000, 100 * MiB, { cpu: 10 }), sample(1500, 100 * MiB, { cpu: 10 })]
    const samplesB = [sample(5000, 150 * MiB, { cpu: 30 }), sample(5500, 120 * MiB, { cpu: 30 }), sample(6000, 110 * MiB, { cpu: 30 })]
    const { container, user, onBack } = setup(
      makeProc({ id: "a", command: "build v1", startedAt: 1000, endedAt: 61_000, status: "exited", exitCode: 0, samples: samplesA, peak: samplesA[0] }),
      makeProc({ id: "b", command: "build v2", startedAt: 5000, endedAt: 95_000, status: "crashed", signal: "SIGKILL", samples: samplesB, peak: samplesB[0] }),
    )
    expect(await screen.findByText("build v1")).toBeInTheDocument()
    expect(screen.getByText("build v2")).toBeInTheDocument()
    expect(screen.getByText("+50 MiB (+50.0%)")).toBeInTheDocument()
    expect(screen.getByText("1m 00s")).toBeInTheDocument()
    expect(screen.getByText("+30s")).toBeInTheDocument()
    expect(screen.getByText("+20.0 pts")).toBeInTheDocument()
    expect(screen.getByText("Killed · SIGKILL")).toBeInTheDocument()
    expect(screen.getByText("Differs")).toBeInTheDocument()
    expect(monitor.getSnapshot().procs, "comparing adds nothing to the session").toHaveLength(before)

    // The tooltip formats elapsed time and bytes.
    await act(() => new Promise((r) => setTimeout(r, 40)))
    fireEvent.mouseMove(container.querySelector(".recharts-wrapper")!, { clientX: 400, clientY: 120 })
    await act(() => new Promise((r) => setTimeout(r, 60)))

    await user.click(screen.getByRole("button", { name: "History" }))
    expect(onBack).toHaveBeenCalled()
  })

  it("keeps unfinished, empty and late-started runs interpretable", async () => {
    setup(
      makeProc({ id: "a", samples: [sample(1000, 0)], peak: sample(1000, 0) }),
      makeProc({ id: "b", startedAt: 1000, samples: [sample(61_000, MiB)], peak: sample(61_000, MiB) }),
    )
    expect(await screen.findByText("No measurements were stored for this run.")).toBeInTheDocument()
    expect(screen.getByText(/starts at T\+1:00/)).toBeInTheDocument()
    expect(screen.getAllByText("Still running")).toHaveLength(2)
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("Same")).toBeInTheDocument()
  })

  it("explains a run that can't be loaded", async () => {
    vi.spyOn(monitor, "loadRun").mockRejectedValue(new Error("run not found"))
    render(<ComparePage ids={ids} onBack={vi.fn()} />)
    expect(await screen.findByText("Couldn't load these runs.")).toBeInTheDocument()
    expect(screen.getByText(/run not found/)).toBeInTheDocument()
  })
})
