import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RELEASES_URL, UPDATE_SUPPORT, UpdateNotice, UpdateProgress, UpdateSection } from "@/components/update-panel"
import { updates, type InstallInfo, type InstallKind, type UpdateState } from "@/lib/updates"

const info = (kind: InstallKind, updatable = false): InstallInfo => ({ version: "0.1.0", commit: "abcdef0123456789", kind, updatable })

function setState(state: UpdateState) {
  vi.spyOn(updates, "getSnapshot").mockReturnValue(state)
}

afterEach(() => vi.restoreAllMocks())

describe("UpdateProgress", () => {
  const show = (state: UpdateState) => render(<UpdateProgress state={state} />)

  it("offers an available update, and only installs when asked", async () => {
    const install = vi.spyOn(updates, "install").mockResolvedValue()
    show({ stage: "available", version: "0.2.0", notes: "Fixes", info: null })
    expect(screen.getByText("Peak 0.2.0 is available.")).toBeInTheDocument()
    expect(screen.getByText("Fixes")).toBeInTheDocument()
    expect(install).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: /Download and install/ }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("leaves out empty release notes", () => {
    const { container } = show({ stage: "available", version: "0.2.0", notes: "", info: null })
    expect(container.querySelectorAll("p")).toHaveLength(1)
  })

  it("shows download progress, with or without a known size", () => {
    const { unmount } = show({ stage: "downloading", version: "0.2.0", done: 1024, total: 2048, info: null })
    expect(screen.getByText("1 KiB of 2 KiB")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    unmount()
    show({ stage: "downloading", version: "0.2.0", done: 1024, total: null, info: null })
    expect(screen.getByText("1 KiB")).toBeInTheDocument()
  })

  it("shows verification and quiet states", () => {
    const a = show({ stage: "installing", version: "0.2.0", info: null })
    expect(screen.getByText("Verifying and installing Peak 0.2.0…")).toBeInTheDocument()
    a.unmount()
    const b = show({ stage: "checking", info: null })
    expect(screen.getByText("Checking for updates…")).toBeInTheDocument()
    b.unmount()
    const c = show({ stage: "current", info: null })
    expect(screen.getByText("This is the latest version.")).toBeInTheDocument()
    c.unmount()
    const d = show({ stage: "idle", info: null })
    expect(d.container).toBeEmptyDOMElement()
  })

  it("restarts straight away when nothing would be stopped", async () => {
    vi.spyOn(updates, "running").mockResolvedValue([])
    const restart = vi.spyOn(updates, "restart").mockResolvedValue()
    show({ stage: "ready", version: "0.2.0", info: null })
    expect(screen.getByText(/Nothing restarts until you say so/)).toBeInTheDocument()
    expect(restart).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: /Restart now/ }))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("names what a restart would stop, and lets you decline", async () => {
    vi.spyOn(updates, "running").mockResolvedValue(["npm test", "sleep 100"])
    const restart = vi.spyOn(updates, "restart").mockResolvedValue()
    show({ stage: "ready", version: "0.2.0", info: null })
    await userEvent.click(screen.getByRole("button", { name: /Restart now/ }))
    expect(await screen.findByText("Restarting stops these 2 commands:")).toBeInTheDocument()
    expect(screen.getByText("npm test")).toBeInTheDocument()
    expect(restart).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Not now" }))
    expect(restart).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: /Restart now/ }))
    await userEvent.click(await screen.findByRole("button", { name: "Stop and restart" }))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("names a single command, and restarts if it can't tell what's running", async () => {
    const running = vi.spyOn(updates, "running").mockResolvedValue(["npm test"])
    const restart = vi.spyOn(updates, "restart").mockResolvedValue()
    show({ stage: "ready", version: "0.2.0", info: null })
    await userEvent.click(screen.getByRole("button", { name: /Restart now/ }))
    expect(await screen.findByText("Restarting stops this command:")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Not now" }))
    running.mockRejectedValue("no")
    await userEvent.click(screen.getByRole("button", { name: /Restart now/ }))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("says each failure's consequence", async () => {
    const check = vi.spyOn(updates, "checkNow").mockResolvedValue()
    const a = show({ stage: "failed", during: "install", message: "bad signature", version: "0.2.0", info: null })
    expect(screen.getByText("Peak 0.2.0 couldn't be installed.")).toBeInTheDocument()
    expect(screen.getByText("bad signature")).toBeInTheDocument()
    expect(screen.getByText(/unchanged and keeps working/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Check again" }))
    expect(check).toHaveBeenCalledTimes(1)
    a.unmount()
    const b = show({ stage: "failed", during: "restart", message: "nope", info: null })
    expect(screen.getByText(/Close and reopen Peak to use it/)).toBeInTheDocument()
    b.unmount()
    show({ stage: "failed", during: "check", message: "offline", info: null })
    expect(screen.getByText("Couldn't check for updates: offline")).toBeInTheDocument()
  })
})

describe("UpdateNotice", () => {
  it("stays away for routine states", () => {
    for (const state of [
      { stage: "idle" },
      { stage: "checking" },
      { stage: "current" },
      { stage: "failed", during: "check", message: "offline" },
    ] as UpdateState[]) {
      setState({ ...state, info: null })
      const { container, unmount } = render(<UpdateNotice />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it("appears for what needs a decision, and an offer can wait", async () => {
    setState({ stage: "available", version: "0.2.0", notes: "", info: null })
    render(<UpdateNotice />)
    expect(screen.getByRole("status", { name: "Peak update" })).toHaveTextContent("Peak 0.2.0 is available.")
    await userEvent.click(screen.getByRole("button", { name: "Later" }))
    await vi.waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("can't be dismissed once an update is under way", () => {
    setState({ stage: "ready", version: "0.2.0", info: null })
    render(<UpdateNotice />)
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Restart now/ })).toBeInTheDocument()
  })
})

describe("UpdateSection", () => {
  it("waits to learn what this copy is", () => {
    setState({ stage: "idle", info: null })
    const { container } = render(<UpdateSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(["appimage", "app", "nsis"] as const)("offers checking on a %s install, except while one is under way", async (kind) => {
    const check = vi.spyOn(updates, "checkNow").mockResolvedValue()
    setState({ stage: "idle", info: info(kind, true) })
    const { unmount } = render(<UpdateSection />)
    expect(screen.getByText("Peak 0.1.0")).toBeInTheDocument()
    expect(screen.getByText("abcdef012345")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(check).toHaveBeenCalledTimes(1)
    unmount()
    setState({ stage: "downloading", version: "0.2.0", done: 0, total: null, info: info(kind, true) })
    render(<UpdateSection />)
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled()
  })

  it.each(["deb", "rpm", "msi", "source"] as const)("says plainly that a %s install doesn't update itself", (kind) => {
    setState({ stage: "idle", info: info(kind) })
    render(<UpdateSection />)
    expect(screen.getByText(UPDATE_SUPPORT[kind])).toBeInTheDocument()
    expect(UPDATE_SUPPORT[kind]).toContain(RELEASES_URL)
    expect(screen.getByText("Peak 0.1.0")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument()
  })

  it("calls the browser demo what it is", () => {
    setState({ stage: "idle", info: { version: "", commit: "", kind: "browser", updatable: false } })
    render(<UpdateSection />)
    expect(screen.getByText(/browser demo, with simulated data/)).toBeInTheDocument()
    expect(screen.queryByText(/^Peak /)).not.toBeInTheDocument()
  })
})

describe("the shared store", () => {
  it("re-renders on change", async () => {
    render(<UpdateSection />)
    await act(async () => {
      updates.start()()
      await Promise.resolve()
    })
  })
})
