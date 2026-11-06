import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { HistoryPage } from "@/components/history-page"
import { monitor, type RunSummary } from "@/lib/monitor"

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: "r", pid: 1, command: "npm test", cwd: "/w", runtime: "node", status: "exited", startedAt: 1e12, endedAt: 1e12 + 90_000,
  exitCode: 0, peakRss: 1024 ** 2, avgCpu: 12, samples: 3, ...over,
})

function setup(runs: RunSummary[]) {
  const handlers = { onClose: vi.fn(), onOpened: vi.fn(), onCompare: vi.fn() }
  const list = vi.spyOn(monitor, "listRuns").mockResolvedValue(runs)
  render(<HistoryPage {...handlers} />)
  return { ...handlers, list, user: userEvent.setup() }
}

describe("HistoryPage", () => {
  it("groups runs by command with their outcomes and figures", async () => {
    const { user, onClose } = setup([
      run({ id: "a" }),
      run({ id: "b", status: "crashed", exitCode: 1 }),
      run({ id: "c", command: "vite", status: "running", endedAt: null, runtime: "go" }),
    ])
    const group = (await screen.findByRole("heading", { name: "npm test" })).closest("section")!
    expect(within(group).getByText("2 runs")).toBeInTheDocument()
    expect(within(group).getByText("Failed · exit 1")).toBeInTheDocument()
    expect(within(group).getAllByText("1m 30s")).toHaveLength(2)
    const vite = screen.getByRole("heading", { name: "vite" }).closest("section")!
    expect(within(vite).getByText("1 run")).toBeInTheDocument()
    expect(within(vite).getByText("Running")).toBeInTheDocument()
    expect(within(vite).getByText("—"), "a running run has no duration yet").toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("searches through the monitor and explains an empty result", async () => {
    const { user, list } = setup([])
    expect(await screen.findByText("No runs recorded yet.")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Search history" }), "x")
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("x"))
    expect(await screen.findByText("No matching runs.")).toBeInTheDocument()
    await user.clear(screen.getByRole("textbox", { name: "Search history" }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(undefined))
  })

  it("opens a run", async () => {
    const open = vi.spyOn(monitor, "openRun").mockResolvedValue()
    const { user, onOpened } = setup([run({ id: "a" })])
    await user.click(await screen.findByRole("button", { name: /^Open npm test/ }))
    expect(open).toHaveBeenCalledWith("a")
    expect(onOpened).toHaveBeenCalled()
  })

  it("deletes only after confirmation, and refreshes", async () => {
    const del = vi.spyOn(monitor, "deleteRun").mockResolvedValue(true)
    const { user, list } = setup([run({ id: "a" }), run({ id: "live", status: "running", endedAt: null })])
    const deletes = await screen.findAllByRole("button", { name: /^Delete npm test/ })
    expect(deletes[1], "a running process can't lose its history").toBeDisabled()
    await user.click(deletes[0])
    await user.click(screen.getByRole("button", { name: "Keep" }))
    expect(del).not.toHaveBeenCalled()

    // A run selected for comparison is deselected when deleted.
    await user.click(screen.getAllByRole("checkbox")[0])
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: /^Delete npm test/ })[0])
    list.mockResolvedValue([])
    await user.click(screen.getByRole("button", { name: /^Confirm deleting/ }))
    expect(del).toHaveBeenCalledWith("a")
    expect(await screen.findByText("No runs recorded yet.")).toBeInTheDocument()
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument()
  })

  it("compares exactly two selected runs", async () => {
    const { user, onCompare } = setup([run({ id: "a" }), run({ id: "b" }), run({ id: "c" })])
    const boxes = await screen.findAllByRole("checkbox")
    const compare = screen.getByRole("button", { name: "Compare" })
    expect(compare).toBeDisabled()
    await user.click(boxes[0])
    expect(compare).toBeDisabled()
    await user.click(boxes[2])
    expect(boxes[1], "a third can't be picked").toBeDisabled()
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument()
    await user.click(compare)
    expect(onCompare).toHaveBeenCalledWith("a", "c")
    await user.click(boxes[0])
    expect(boxes[1]).toBeEnabled()
  })

  it("surfaces backend failures", async () => {
    vi.spyOn(monitor, "openRun").mockRejectedValue(new Error("no open"))
    vi.spyOn(monitor, "deleteRun").mockRejectedValue(new Error("no delete"))
    const { user, list, onOpened } = setup([run({ id: "a" })])
    await user.click(await screen.findByRole("button", { name: /^Open/ }))
    expect(onOpened).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /^Delete/ }))
    await user.click(screen.getByRole("button", { name: /^Confirm/ }))
    list.mockRejectedValue(new Error("no list"))
    await user.type(screen.getByRole("textbox", { name: "Search history" }), "x")
    expect(await screen.findByText("No matching runs.")).toBeInTheDocument()
  })
})
