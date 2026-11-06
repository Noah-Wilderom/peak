import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { LogsPanel } from "@/components/logs-panel"
import { makeProc } from "@/test/fixtures"

const logs = [
  { id: 1, t: 2000, stream: "stdout" as const, text: "first" },
  { id: 2, t: 4000, stream: "stderr" as const, text: "problem" },
  { id: 3, t: 60_000, stream: "stdout" as const, text: "much later" },
]
const proc = makeProc({ startedAt: 1000, logs })

describe("LogsPanel on remote runs", () => {
  const target = { targetId: "t", label: "box", kind: "ssh" as const, launched: false, clockOffsetMs: 0, identity: { bootId: "b", pidNs: "n", pid: 1, startTicks: 1 } }

  it("doesn't promise output it never captured, and points at platform logs", () => {
    const { rerender } = render(<LogsPanel proc={makeProc({ target })} />)
    expect(screen.getByText(/aren't captured here/)).toBeInTheDocument()
    expect(screen.queryByText(/Targets page/)).not.toBeInTheDocument()
    rerender(<LogsPanel proc={makeProc({ target: { ...target, kind: "kubernetes" } })} />)
    expect(screen.getByText(/Container logs are on the Targets page/)).toBeInTheDocument()
    rerender(<LogsPanel proc={makeProc({ target: { ...target, launched: true } })} />)
    expect(screen.queryByText(/aren't captured here/)).not.toBeInTheDocument()
  })
})

describe("LogsPanel jumps", () => {
  it("highlights the closest line and shows every stream", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<LogsPanel proc={proc} jump={null} />)
    await user.click(screen.getByRole("radio", { name: "stdout" }))
    expect(screen.queryByText("problem")).not.toBeInTheDocument()
    rerender(<LogsPanel proc={proc} jump={{ t: 4100, seq: 1 }} />)
    expect(screen.getByText("problem").closest("[data-log]")).toHaveClass("bg-signal/10")
    expect(screen.getByText("Output at T+0:03.")).toBeInTheDocument()
    // Output arriving afterwards doesn't move the highlight.
    rerender(<LogsPanel proc={{ ...proc, logs: [...logs, { id: 4, t: 4100, stream: "stdout", text: "newer" }] }} jump={{ t: 4100, seq: 1 }} />)
    expect(screen.getByText("problem").closest("[data-log]")).toHaveClass("bg-signal/10")
    expect(screen.getByText("newer").closest("[data-log]")).not.toHaveClass("bg-signal/10")
  })

  it("says so when nothing was logged near that time", () => {
    render(<LogsPanel proc={proc} jump={{ t: 30_000, seq: 1 }} />)
    expect(screen.getByText("No output within 5s of T+0:29; showing the nearest line.")).toBeInTheDocument()
  })

  it("handles a run with no output, and following resumes on request", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<LogsPanel proc={makeProc({ logs: [] })} jump={{ t: 5000, seq: 1 }} />)
    expect(screen.getByText("This run recorded no output.")).toBeInTheDocument()
    unmount()
    render(<LogsPanel proc={proc} jump={{ t: 2000, seq: 1 }} />)
    await user.click(await screen.findByRole("button", { name: "Follow output" }))
    expect(screen.queryByText(/^Output at/)).not.toBeInTheDocument()
  })
})
