import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProfilerTab } from "@/components/profiler-tab"
import { monitor, type CpuProfile } from "@/lib/monitor"
import { makeProc } from "@/test/fixtures"

const root = { name: "(root)", self: 0, children: [{ name: "work", file: "a.js:1", self: 1500, children: [] }, { name: "wait", self: 250, children: [] }] }
const profile = (id: string, over: Partial<CpuProfile> = {}): CpuProfile => ({ id, t: 3000, durationMs: 5000, sampling: "v8", root, ...over })

async function cpuTab(proc = makeProc()) {
  const user = userEvent.setup()
  const view = render(<ProfilerTab proc={proc} />)
  await user.click(screen.getByRole("radio", { name: "CPU" }))
  return { user, ...view }
}

afterEach(() => vi.useRealTimers())

describe("CPU profiles in the Profiler tab", () => {
  it("records 5s and 10s, showing progress, then shows the result", async () => {
    let finish!: (p: CpuProfile) => void
    const record = vi.spyOn(monitor, "cpuProfile").mockImplementation(() => new Promise((r) => (finish = r)))
    const { user } = await cpuTab()
    expect(screen.getByText("No CPU profiles yet.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Record 5s" }))
    expect(record).toHaveBeenCalledWith("p1", 5000)
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent(/Recording… .* of 5s/)
    expect(screen.getByRole("button", { name: "Record 10s" }), "one at a time").toBeDisabled()
    await waitFor(() => expect(status).not.toHaveTextContent("Recording… 0ms"), { timeout: 2000 })
    await act(async () => finish(profile("c1")))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Record 10s" }))
    expect(record).toHaveBeenLastCalledWith("p1", 10_000)
  })

  it("renders time values, and says what the time means per sampling method", async () => {
    const proc = makeProc({ cpuProfiles: [profile("a", { durationMs: 10_000, sampling: "stack" }), profile("b")] })
    const { user, container } = await cpuTab(proc)
    expect(screen.getByText(/Sampled by V8/)).toBeInTheDocument()
    expect(screen.getByText(/isn't purely on-CPU/)).toBeInTheDocument()
    expect(screen.getByText("Profile 2")).toBeInTheDocument()
    fireEvent.mouseEnter(container.querySelectorAll("button.absolute")[1])
    expect(await screen.findByText(/1\.5s total/)).toBeInTheDocument()
    expect(screen.queryByText(/KiB|MiB|\bB\b total/)).not.toBeInTheDocument()

    await user.click(screen.getByText("Profile 1"))
    expect(screen.getByText(/Sleeps, I\/O and lock waits are included/)).toBeInTheDocument()
    expect(screen.getByText(/elapsed time, not on-CPU/)).toBeInTheDocument()
  })

  it("is honest about older profiles with no recorded method", async () => {
    await cpuTab(makeProc({ cpuProfiles: [profile("a", { sampling: undefined })] }))
    expect(screen.getByText(/Sampling method wasn't recorded/)).toBeInTheDocument()
  })

  it("shows an unsupported or failed recording, and allows another try", async () => {
    vi.spyOn(monitor, "cpuProfile").mockRejectedValueOnce(new Error("no profiling agent is attached"))
    const { user } = await cpuTab()
    await user.click(screen.getByRole("button", { name: "Record 5s" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("no profiling agent is attached")
    expect(screen.getByRole("button", { name: "Record 5s" })).toBeEnabled()
  })

  it("keeps stored profiles viewable on ended runs and on agents that have gone", async () => {
    const stored = makeProc({ status: "exited", profiling: false, cpuProfiles: [profile("a")] })
    const { unmount } = await cpuTab(stored)
    expect(screen.getByText("This run has ended, so nothing new can be recorded.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Record 5s" })).toBeDisabled()
    expect(screen.getByText("CPU profile.")).toBeInTheDocument()
    unmount()
    await cpuTab(makeProc({ profiling: false, cpuProfiles: [profile("a")] }))
    expect(screen.getByText("No profiling agent is connected to this process.")).toBeInTheDocument()
  })

  it("keeps heap views in bytes", async () => {
    const snap = { id: "s", t: 1, heapUsed: 2048, entries: [], sites: { name: "(root)", self: 0, children: [{ name: "alloc", self: 4096, children: [] }] } }
    const user = userEvent.setup()
    const { container } = render(<ProfilerTab proc={makeProc({ snapshots: [snap] })} />)
    fireEvent.mouseEnter(container.querySelectorAll("button.absolute")[1])
    expect(await screen.findByText(/4 KiB total/)).toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "CPU" }))
    await user.click(screen.getByRole("radio", { name: "Heap" }))
    expect(screen.getByText("Heap by type.")).toBeInTheDocument()
  })

  it("doesn't touch state if the tab is gone when a recording ends", async () => {
    let finish!: (p: CpuProfile) => void
    let fail!: (e: Error) => void
    const record = vi.spyOn(monitor, "cpuProfile")
    record.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const a = await cpuTab()
    await a.user.click(screen.getByRole("button", { name: "Record 5s" }))
    a.unmount()
    await act(async () => finish(profile("late")))
    record.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    const b = await cpuTab()
    await b.user.click(screen.getByRole("button", { name: "Record 5s" }))
    b.unmount()
    await act(async () => fail(new Error("late")))
  })
})
