import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type AppType from "@/App"
import type { monitor as MonitorType } from "@/lib/monitor"

// Every test gets a fresh mock store.
let App: typeof AppType
let monitor: typeof MonitorType
beforeEach(async () => {
  vi.resetModules()
  App = (await import("@/App")).default
  monitor = (await import("@/lib/monitor")).monitor
})

/** Hover every chart so tooltips (and their formatters) render. Recharts
 * handles pointer events on the next animation frame. */
async function hoverCharts(container: HTMLElement) {
  await act(() => new Promise((r) => setTimeout(r, 40)))
  for (const svg of container.querySelectorAll(".recharts-wrapper")) {
    fireEvent.mouseMove(svg, { clientX: 400, clientY: 120 })
  }
  await act(() => new Promise((r) => setTimeout(r, 60)))
}

/** Select a process in the sidebar and wait for its view to replace the old one. */
async function openProc(user: ReturnType<typeof userEvent.setup>, sidebar: HTMLElement, name: string | RegExp) {
  await user.click(within(sidebar).getAllByText(name)[0])
  await waitFor(() => {
    const h1s = document.querySelectorAll("h1")
    expect(h1s).toHaveLength(1)
    expect(h1s[0].textContent).toMatch(name)
  })
}

const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

describe("App", () => {
  it("walks through every view of a process", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)

    // Sidebar lists running and ended processes.
    const sidebar = container.querySelector("aside")!
    expect(await within(sidebar).findByText("Running")).toBeInTheDocument()
    expect(within(sidebar).getByText("Ended")).toBeInTheDocument()

    // Overview: tiles, charts, time controls.
    expect(screen.getAllByText("Peak memory").length).toBeGreaterThan(0)
    await hoverCharts(container)
    await user.click(screen.getByRole("radio", { name: "30s" }))
    await user.click(screen.getByRole("radio", { name: "Clock" }))
    await user.click(screen.getByRole("radio", { name: "T+" }))
    // Long ranges redraw ~1×/s, which keeps the rest of this test fast.
    await user.click(screen.getByRole("radio", { name: "1h" }))

    // Drag across the memory chart to zoom, then reset.
    const frame = () => act(() => new Promise((r) => setTimeout(r, 40)))
    const chart = () => container.querySelectorAll(".recharts-wrapper")[1] ?? container.querySelector(".recharts-wrapper")!
    const main = [...container.querySelectorAll("section")].find((s) => s.textContent?.startsWith("Memory."))!
    const memChart = () => main.querySelector(".recharts-wrapper")!
    fireEvent.mouseMove(memChart(), { clientX: 150, clientY: 120 })
    await frame()
    fireEvent.mouseDown(memChart(), { clientX: 150, clientY: 120 })
    await frame()
    fireEvent.mouseMove(memChart(), { clientX: 650, clientY: 120 })
    await frame()
    fireEvent.mouseUp(memChart(), { clientX: 650, clientY: 120 })
    const chip = await screen.findByRole("button", { name: /–/ })
    await user.click(chip)
    // Start a drag on the CPU and I/O charts too, then leave without releasing.
    for (const w of [...container.querySelectorAll(".recharts-wrapper")].slice(-2)) {
      fireEvent.mouseMove(w, { clientX: 150, clientY: 120 })
      await frame()
      fireEvent.mouseDown(w, { clientX: 150, clientY: 120 })
      await frame()
      fireEvent.mouseMove(w, { clientX: 500, clientY: 120 })
      await frame()
      fireEvent.mouseOut(w)
      fireEvent.mouseLeave(w)
      await frame()
    }
    void chart

    // Memory tab.
    await user.click(screen.getByRole("tab", { name: "Memory" }))
    expect(await screen.findByText("Composition.")).toBeInTheDocument()
    expect(screen.getByText("Right now")).toBeInTheDocument()
    await hoverCharts(container)

    // Profiler tab: snapshots, treemap, flame graph.
    await user.click(screen.getByRole("tab", { name: /Profiler/ }))
    expect(await screen.findByText("Heap by type.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Take snapshot/ }))
    await waitFor(() => expect(screen.getByText("Snapshot 4")).toBeInTheDocument())
    await user.click(screen.getByText("Snapshot 1"))
    expect(screen.getByText("First snapshot")).toBeInTheDocument()
    await user.click(screen.getByText("Snapshot 4"))
    await user.click(screen.getByRole("button", { name: /Collect garbage/ }))
    await hoverCharts(container)
    const frames = container.querySelectorAll("button.absolute")
    fireEvent.mouseEnter(frames[1])
    await user.click(frames[1])
    await user.click(await screen.findByText("Reset zoom"))
    fireEvent.mouseLeave(container.querySelector("button.absolute")!.parentElement!)

    // Stats tab, including copy-as-JSON.
    await user.click(screen.getByRole("tab", { name: "Stats" }))
    expect(await screen.findByText("Process.")).toBeInTheDocument()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    // PIDs are click-to-copy.
    await user.click(screen.getByRole("button", { name: /Copy PID/ }))
    expect(writeText).toHaveBeenCalledWith("48213")
    await user.click(screen.getByRole("button", { name: /Copy as JSON/ }))
    expect(writeText).toHaveBeenCalled()
    expect(await screen.findByText("Copied")).toBeInTheDocument()

    // Output tab: stream filter and follow.
    await user.click(screen.getByRole("tab", { name: /Output/ }))
    await user.click(screen.getByRole("radio", { name: /stderr/ }))
    await user.click(screen.getByRole("radio", { name: "stdout" }))
    const log = container.querySelector(".font-mono.overflow-y-auto, .overflow-y-auto.font-mono") as HTMLElement
    Object.defineProperty(log, "scrollHeight", { value: 5000, configurable: true })
    fireEvent.scroll(log, { target: { scrollTop: 0 } })
    await user.click(await screen.findByText("Follow output"))

    // Processes tab.
    await user.click(screen.getByRole("tab", { name: /Processes/ }))
    expect(screen.getByText("Command")).toBeInTheDocument()

    // Freeze / resume.
    await user.click(screen.getByRole("button", { name: /Freeze/ }))
    expect(await screen.findByText(/View frozen/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Resume/ }))
  })

  it("handles ended processes, removal and filtering", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    const sidebar = container.querySelector("aside")!
    await openProc(user, sidebar, /ingest\.py/)
    expect(await screen.findByText("Killed · SIGKILL")).toBeInTheDocument()
    expect(screen.getAllByText(/Ended/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole("tab", { name: "Memory" }))
    await user.click(screen.getByRole("tab", { name: "Stats" }))
    await user.click(screen.getByRole("tab", { name: /Processes/ }))
    expect(screen.getByText(/torn down/)).toBeInTheDocument()

    // Rust process: no collector.
    await openProc(user, sidebar, "cargo watch -x check")
    await user.click(screen.getByRole("tab", { name: "Memory" }))
    expect(await screen.findByText(/no collector to observe/)).toBeInTheDocument()

    // Remove an ended process and restart another.
    await openProc(user, sidebar, "bun run build")
    await user.click(screen.getByRole("button", { name: "Run again" }))
    await openProc(user, sidebar, /ingest\.py/)
    await user.click(screen.getByRole("button", { name: "Remove" }))
    expect(within(sidebar).queryByText(/ingest\.py/)).not.toBeInTheDocument()

    // Stop, then clear everything that ended.
    await openProc(user, sidebar, "node worker.js --queue emails")
    await user.click(screen.getByRole("button", { name: "Stop" }))
    await user.click(within(sidebar).getByText("Clear"))

    // Filter the sidebar.
    await user.type(within(sidebar).getByPlaceholderText("Filter processes"), "zzzz")
    expect(within(sidebar).getByText("Nothing running.")).toBeInTheDocument()
    await user.clear(within(sidebar).getByPlaceholderText("Filter processes"))
    await user.type(within(sidebar).getByPlaceholderText("Filter processes"), "48213")
    expect(within(sidebar).getByText("bun run dev")).toBeInTheDocument()
  })

  it("captures and attaches from the capture page", async () => {
    const user = userEvent.setup({ delay: null })
    render(<App />)
    await screen.findByText("bun run dev", { selector: "h1" })
    await user.click(screen.getByRole("button", { name: "Capture" }))
    expect(await screen.findByText("Capture a process.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByText("Capture a process.")).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    expect(await screen.findByText("Capture a process.")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "x", ctrlKey: true })

    // Attach list: filter, refresh, attach.
    expect(await screen.findByText("vite --port 5173")).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText("Filter by command or PID"), "nothing-matches")
    expect(screen.getByText("No matching processes.")).toBeInTheDocument()
    await user.clear(screen.getByPlaceholderText("Filter by command or PID"))
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await user.click(await screen.findByText("uv run serve.py"))
    expect(await screen.findByText("uv run serve.py", { selector: "h1" })).toBeInTheDocument()

    // Run a command (suggestion chip + submit).
    await user.click(screen.getByRole("button", { name: "Capture" }))
    await user.click(await screen.findByRole("button", { name: "npm test" }))
    await user.clear(screen.getByDisplayValue("~"))
    await user.type(screen.getByRole("textbox", { name: "Working directory" }), "/tmp")
    await user.click(screen.getByRole("button", { name: /Run and capture/ }))
    expect(await screen.findByText("npm test", { selector: "h1" })).toBeInTheDocument()

    // Selecting the already-selected process leaves the capture page.
    await user.click(screen.getByRole("button", { name: "Capture" }))
    await screen.findByText("Capture a process.")
    const sidebar = document.querySelector("aside")!
    await user.click(within(sidebar).getAllByText("npm test")[0])
    expect(await screen.findByText("npm test", { selector: "h1" })).toBeInTheDocument()
  })

  it("covers runtimes without a collector or profiler", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    await screen.findByText("bun run dev", { selector: "h1" })
    await act(() => monitor.capture("make all", "~"))
    await screen.findByText("make all", { selector: "h1" })
    await user.click(screen.getByRole("tab", { name: "Memory" }))
    expect(await screen.findByText("No collector data for this runtime.")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: /Profiler/ }))
    expect(await screen.findByText("Heap profiling isn't available.")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Stats" }))
    expect(await screen.findByText("Not observed")).toBeInTheDocument()
    // A process that fails with an exit code (no signal) gets a "failed" label and toast.
    const id = monitor.getSnapshot().procs[0].id
    vi.spyOn(console, "error").mockImplementation(() => {})
    act(() => monitor.kill(id))
    expect(container).toBeTruthy()
  })

  it("switches themes", async () => {
    const user = userEvent.setup({ delay: null })
    render(<App />)
    await user.click(await screen.findByRole("radio", { name: "Dark theme" }))
    expect(document.documentElement).toHaveClass("dark")
    await user.click(screen.getByRole("radio", { name: "Light theme" }))
    expect(document.documentElement).not.toHaveClass("dark")
    await user.click(screen.getByRole("radio", { name: "System theme" }))
  })

  it("shows the capture page as the empty state and surfaces errors", async () => {
    const user = userEvent.setup({ delay: null })
    vi.spyOn(monitor, "listAttachable").mockRejectedValueOnce(new Error("denied"))
    vi.spyOn(monitor, "capture").mockRejectedValueOnce(new Error("no such dir"))
    vi.spyOn(monitor, "attach").mockRejectedValueOnce(new Error("gone"))
    render(<App />)
    await screen.findByText("bun run dev", { selector: "h1" })
    monitor.clearEnded()
    for (const p of monitor.getSnapshot().procs) monitor.kill(p.id)
    act(() => monitor.clearEnded())
    expect(await screen.findByText("Capture a process.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    expect(await screen.findByText("Couldn't list processes")).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText("bun run build"), "oops")
    await user.click(screen.getByRole("button", { name: /Run and capture/ }))
    expect(await screen.findByText("Couldn't start process")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await user.click(await screen.findByText("vite --port 5173"))
    expect(await screen.findByText("Couldn't attach")).toBeInTheDocument()
    await sleep(10)
  })
})
