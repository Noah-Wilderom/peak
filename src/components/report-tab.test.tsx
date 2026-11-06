import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { ReportTab } from "@/components/report-tab"
import { makeProc, sample } from "@/test/fixtures"

const MiB = 1024 ** 2
const snapshot = {
  id: "s", t: 3000, heapUsed: 10 * MiB,
  entries: [{ name: "Leaky", count: 1, shallow: 1, retained: 4 * MiB }],
  sites: { name: "(root)", self: 0, children: [{ name: "alloc", file: "a.js:1", self: MiB, children: [] }, { name: "bare", self: 2 * MiB, children: [] }] },
}

describe("ReportTab", () => {
  it("shows the verdict, summary, allocators and alerts, and copies both formats", async () => {
    const proc = makeProc({
      status: "crashed", exitCode: 137, signal: "SIGKILL", endedAt: 11_000, snapshots: [snapshot],
      gc: [{ t: 1200, kind: "minor", pauseMs: 100, freed: 1 }],
      alerts: [{ t: 2000, kind: "memory", message: "Memory above 1 MiB", value: 2, threshold: 1 }],
    })
    render(<ReportTab proc={proc} />)
    expect(screen.getByRole("heading", { name: "Failed." })).toBeInTheDocument()
    expect(screen.getByText("Exit code 137")).toBeInTheDocument()
    expect(screen.getByText("start to exit")).toBeInTheDocument()
    expect(screen.getByText("1.0%")).toBeInTheDocument()
    expect(screen.getByText("Leaky")).toBeInTheDocument()
    expect(screen.getByText("alloc")).toHaveAttribute("title", "a.js:1")
    expect(screen.getByText("bare")).not.toHaveAttribute("title")
    expect(screen.getByText("Memory above 1 MiB")).toBeInTheDocument()

    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }))
    expect(writeText.mock.calls[0][0]).toContain("# Peak run report")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Copy JSON" }))
    expect(JSON.parse(writeText.mock.calls[1][0]).outcome).toBe("Killed · SIGKILL")
    await waitFor(() => expect(screen.queryByRole("button", { name: "Copied" }), "the confirmation clears").not.toBeInTheDocument(), { timeout: 3000 })
  })

  it("says so when the clipboard refuses", async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true })
    render(
      <>
        <ReportTab proc={makeProc()} />
        <Toaster />
      </>,
    )
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }))
    expect(await screen.findByText("Couldn't copy the report")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument()
  })

  it("names the target, gaps and what couldn't be read", () => {
    const target = { targetId: "t", label: "box", kind: "docker" as const, launched: false, clockOffsetMs: 0, identity: { bootId: "b", pidNs: "n", pid: 1, startTicks: 1 } }
    const { rerender } = render(<ReportTab proc={makeProc({ status: "exited", signal: "ended while disconnected", target, gaps: [{ from: 1, to: 2 }], unavailable: ["io", "fds"] })} />)
    expect(screen.getByRole("heading", { name: "Outcome unknown." })).toBeInTheDocument()
    expect(screen.getByText("until last seen")).toBeInTheDocument()
    expect(screen.getByText(/On box \(docker\), attached\. 1 gap in the data.*Couldn't read: io, fds\./)).toBeInTheDocument()
    rerender(<ReportTab proc={makeProc({ target: { ...target, launched: true }, gaps: [{ from: 1, to: 2 }, { from: 3, to: 4 }] })} />)
    expect(screen.getByText(/launched by peak\. 2 gaps/)).toBeInTheDocument()
    rerender(<ReportTab proc={makeProc({ unavailable: ["fds"] })} />)
    expect(screen.getByText(/^Couldn't read: fds\.|Couldn't read: fds\./)).toBeInTheDocument()
  })

  it("represents missing data and unfinished runs honestly", () => {
    const { rerender } = render(<ReportTab proc={makeProc({ samples: [sample(1000, 5)] })} />)
    expect(screen.getByText("so far")).toBeInTheDocument()
    expect(screen.getByText("Not observed")).toBeInTheDocument()
    expect(screen.getByText("No exit code recorded")).toBeInTheDocument()
    expect(screen.getByText(/No heap snapshot was taken/)).toBeInTheDocument()
    expect(screen.getByText("No alerts fired during this run.")).toBeInTheDocument()
    rerender(<ReportTab proc={makeProc({ status: "exited", signal: "peak closed" })} />)
    expect(screen.getByText("until peak closed")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Interrupted." })).toBeInTheDocument()
    rerender(<ReportTab proc={makeProc({ snapshots: [{ ...snapshot, sites: { name: "(root)", self: 0, children: [] } }] })} />)
    expect(screen.getByText("No allocation sites in this snapshot.")).toBeInTheDocument()
  })
})
