import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { TargetActions } from "@/components/target-actions"
import { monitor, NEW_TARGET, type Proc, type ProcTarget, type TargetState } from "@/lib/monitor"
import { makeProc } from "@/test/fixtures"

const NONE = { collector: false, attach: false, launch: false, signal: false, runtimeAgents: false, containerTotals: false, containerLogs: false, containerTop: false }
const target = (over: Partial<TargetState["capabilities"]> = {}): TargetState => ({
  spec: { ...NEW_TARGET, id: "t", label: "box" }, state: "connected", error: null, capabilities: { ...NONE, signal: true, ...over }, facts: null, system: null, clockOffsetMs: 0,
})
const remote = (launched: boolean, over: Partial<Proc> = {}) =>
  makeProc({
    id: "t~1",
    target: { targetId: "t", label: "box", kind: "ssh", launched, clockOffsetMs: 0, identity: { bootId: "b", pidNs: "n", pid: 42, startTicks: 9 } } satisfies ProcTarget,
    ...over,
  })

describe("TargetActions", () => {
  it("a launched command can be stopped and detached from; nothing implies a signal", async () => {
    const kill = vi.spyOn(monitor, "kill").mockImplementation(() => {})
    const detach = vi.spyOn(monitor, "detach").mockResolvedValue()
    const user = userEvent.setup()
    render(<TargetActions proc={remote(true)} target={target()} linked />)
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(kill).toHaveBeenCalledWith("t~1")
    await user.click(screen.getByRole("button", { name: "Detach" }))
    expect(detach).toHaveBeenCalledWith("t~1")
    expect(screen.queryByRole("button", { name: /Signal/ })).not.toBeInTheDocument()
  })

  it("an attached service has no Stop; signalling takes a deliberate second step", async () => {
    const signal = vi.spyOn(monitor, "signal").mockResolvedValue()
    const user = userEvent.setup()
    render(<TargetActions proc={remote(false)} target={target()} linked />)
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Signal/ }))
    expect(signal).not.toHaveBeenCalled()
    expect(screen.getByRole("group", { name: /PID 42 on box/ })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: /Signal/ }))
    await user.click(screen.getByRole("button", { name: "TERM" }))
    expect(signal).toHaveBeenCalledWith("t~1", "TERM")
  })

  it("disables what can't reach the target, while detaching still works", () => {
    const { rerender } = render(<TargetActions proc={remote(true)} target={target()} linked={false} />)
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Detach" })).toBeEnabled()
    rerender(<TargetActions proc={remote(false)} target={target()} linked={false} />)
    expect(screen.getByRole("button", { name: /Signal/ })).toBeDisabled()
    rerender(<TargetActions proc={remote(false)} target={target({ signal: false })} linked />)
    expect(screen.getByRole("button", { name: /Signal/ }), "capabilities govern it").toBeDisabled()
    rerender(<TargetActions proc={remote(false)} linked />)
    expect(screen.getByRole("button", { name: /Signal/ })).toBeDisabled()
  })

  it("only commands peak launched can run again", async () => {
    const restart = vi.spyOn(monitor, "restart").mockImplementation(() => {})
    const user = userEvent.setup()
    const { rerender, container } = render(<TargetActions proc={remote(true, { status: "exited" })} target={target()} linked />)
    await user.click(screen.getByRole("button", { name: "Run again" }))
    expect(restart).toHaveBeenCalledWith("t~1")
    rerender(<TargetActions proc={remote(true, { status: "exited" })} target={target()} linked={false} />)
    expect(screen.getByRole("button", { name: "Run again" })).toBeDisabled()
    rerender(<TargetActions proc={remote(false, { status: "exited" })} target={target()} linked />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reports failures", async () => {
    vi.spyOn(monitor, "detach").mockRejectedValue(new Error("nope"))
    vi.spyOn(monitor, "signal").mockRejectedValue(new Error("different process"))
    const user = userEvent.setup()
    render(
      <>
        <TargetActions proc={remote(false)} target={target()} linked />
        <Toaster />
      </>,
    )
    await user.click(screen.getByRole("button", { name: "Detach" }))
    expect(await screen.findByText("Couldn't detach")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Signal/ }))
    await user.click(screen.getByRole("button", { name: "KILL" }))
    await waitFor(() => expect(screen.getByText("Couldn't send the signal")).toBeInTheDocument())
  })
})
