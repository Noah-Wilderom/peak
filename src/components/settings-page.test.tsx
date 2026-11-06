import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { SettingsPage } from "@/components/settings-page"
import { monitor, DEFAULT_SETTINGS, type Settings, type StorageInfo } from "@/lib/monitor"

const info: StorageInfo = { path: "/data/peak.db", bytes: 2048, runs: 5, stoppedRuns: 4, samples: 900 }

function setup(settings: Settings = DEFAULT_SETTINGS) {
  vi.spyOn(monitor, "getSettings").mockResolvedValue(settings)
  const set = vi.spyOn(monitor, "setSettings").mockImplementation(async (s) => s)
  const storage = vi.spyOn(monitor, "storageInfo").mockResolvedValue(info)
  const prune = vi.spyOn(monitor, "pruneRuns").mockResolvedValue(2)
  const vacuum = vi.spyOn(monitor, "vacuum").mockResolvedValue()
  const onClose = vi.fn()
  render(
    <>
      <SettingsPage onClose={onClose} />
      <Toaster />
    </>,
  )
  return { set, storage, prune, vacuum, onClose, user: userEvent.setup() }
}

describe("SettingsPage", () => {
  it("shows saved values and storage figures", async () => {
    setup({ ...DEFAULT_SETTINGS, retentionDays: 14 })
    expect(await screen.findByRole("textbox", { name: "Retention days" })).toHaveValue("14")
    expect(screen.getByRole("textbox", { name: "Maximum runs" })).toHaveValue("500")
    expect(screen.getByText("/data/peak.db")).toBeInTheDocument()
    expect(screen.getByText("2 KiB")).toBeInTheDocument()
    expect(screen.getByText("5 (4 stopped)")).toBeInTheDocument()
    expect(screen.getByText("900")).toBeInTheDocument()
  })

  it("saves edits and can discard them", async () => {
    const { user, set, storage } = setup()
    const days = await screen.findByRole("textbox", { name: "Retention days" })
    const save = screen.getByRole("button", { name: "Save settings" })
    expect(save).toBeDisabled()
    await user.clear(days)
    await user.type(days, "7")
    expect(days).toHaveValue("7")
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Discard" }))
    expect(days).toHaveValue("30")

    await user.clear(days)
    await user.type(days, "7")
    const max = screen.getByRole("textbox", { name: "Maximum runs" })
    await user.clear(max)
    await user.type(max, "abc")
    expect(max, "not a number means off").toHaveValue("0")
    await user.type(screen.getByRole("textbox", { name: "Memory threshold in MiB" }), "512")
    await user.type(screen.getByRole("textbox", { name: "CPU duration in seconds" }), "5")
    const cpu = screen.getByRole("textbox", { name: "CPU threshold in percent" })
    await user.clear(cpu)
    await user.type(cpu, "150")
    await user.click(screen.getByRole("radio", { name: "Alerts off" }))
    await user.click(screen.getByRole("radio", { name: "Desktop notifications off" }))
    const before = storage.mock.calls.length
    await user.click(save)
    expect(set).toHaveBeenCalledWith({
      retentionDays: 7, maxRuns: 0, alertsEnabled: false, notifications: false,
      alertMemoryMib: 512, alertCpuPercent: 150, alertCpuSeconds: 5,
    })
    await waitFor(() => expect(storage.mock.calls.length, "retention may have removed runs").toBeGreaterThan(before))
    expect(await screen.findByText("Settings saved")).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.click(screen.getByRole("radio", { name: "Alerts on" }))
    expect(save).toBeEnabled()
  })

  it("runs each maintenance action with a clear outcome and fresh figures", async () => {
    const { user, prune, vacuum, storage, set } = setup()
    await screen.findByText("/data/peak.db")
    storage.mockResolvedValue({ ...info, stoppedRuns: 2, bytes: 1024 })

    const age = screen.getByRole("textbox", { name: "Prune age in days" })
    await user.clear(age)
    await user.type(age, "10.9")
    await user.click(screen.getByRole("button", { name: "Delete old runs" }))
    expect(prune).toHaveBeenCalledWith(10)
    expect(await screen.findByText("Removed 2 runs")).toBeInTheDocument()
    expect(await screen.findByText("1 KiB")).toBeInTheDocument()

    await user.clear(age)
    await user.type(age, "junk")
    prune.mockResolvedValue(1)
    await user.click(screen.getByRole("button", { name: "Delete old runs" }))
    expect(prune).toHaveBeenLastCalledWith(0)
    expect(await screen.findByText("Removed 1 run")).toBeInTheDocument()

    // "All" needs confirming, and says what it leaves alone.
    await user.click(screen.getByRole("button", { name: "Delete all stopped runs" }))
    expect(screen.getByText(/Running processes are not affected/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Keep" }))
    await user.click(screen.getByRole("button", { name: "Delete all stopped runs" }))
    await user.click(screen.getByRole("button", { name: "Delete all" }))
    await waitFor(() => expect(prune).toHaveBeenLastCalledWith())
    expect(set).not.toHaveBeenCalled()

    await user.click(await screen.findByRole("button", { name: /Compact database/ }))
    expect(vacuum).toHaveBeenCalled()
    expect(await screen.findByText("Database compacted")).toBeInTheDocument()
  })

  it("reports failures and can send a test notification", async () => {
    const { user, set, vacuum, onClose } = setup()
    await screen.findByText("/data/peak.db")
    vacuum.mockRejectedValue(new Error("locked"))
    await user.click(screen.getByRole("button", { name: /Compact database/ }))
    expect(await screen.findByText("Storage maintenance failed")).toBeInTheDocument()
    set.mockRejectedValue(new Error("readonly"))
    await user.click(screen.getByRole("radio", { name: "Alerts off" }))
    await user.click(screen.getByRole("button", { name: "Save settings" }))
    expect(await screen.findByText("Couldn't save settings")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("says a test notification was handed over, not that it appeared", async () => {
    const { user } = setup()
    await screen.findByText("/data/peak.db")
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "granted" }))
    await user.click(screen.getByRole("button", { name: "Send test" }))
    expect(await screen.findByText("Test notification handed over")).toBeInTheDocument()
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "denied", requestPermission: async () => "denied" }))
    await user.click(screen.getByRole("button", { name: "Send test" }))
    expect(await screen.findByText("Couldn't send a notification")).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it("explains a backend that can't load", async () => {
    vi.spyOn(monitor, "getSettings").mockRejectedValue(new Error("gone"))
    vi.spyOn(monitor, "storageInfo").mockResolvedValue(info)
    render(
      <>
        <SettingsPage onClose={vi.fn()} />
        <Toaster />
      </>,
    )
    expect(await screen.findByText("Couldn't load settings")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument()
  })
})
