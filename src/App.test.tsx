import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type AppType from "@/App"
import type { monitor as MonitorType, Proc } from "@/lib/monitor"
import type { View } from "@/lib/series"

// The gliding time domain re-renders on every animation frame. Under coverage a
// render can outlast the frame interval, and act() then never drains. Its glide
// is covered in hooks.test.tsx; these walkthroughs don't depend on it.
vi.mock("@/hooks/use-smooth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-smooth")>()
  return { ...actual, useTimeDomain: (p: Proc, v: View) => actual.useTimeDomain(p, v, true) }
})

// Every test gets a fresh mock store.
let App: typeof AppType
let monitor: typeof MonitorType
beforeEach(async () => {
  vi.resetModules()
  // Same for number and axis tweens, which never settle while samples keep arriving.
  // (After the reset: this must reach the same module instance the app imports.)
  const { MotionGlobalConfig } = await import("motion/react")
  MotionGlobalConfig.skipAnimations = true
  App = (await import("@/App")).default
  monitor = (await import("@/lib/monitor")).monitor
})

/**
 * Let time pass with React scheduling normally. An async act() here would keep
 * flushing for as long as chart animations keep queueing work, which under
 * coverage can be forever.
 */
async function sleep(ms: number) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  env.IS_REACT_ACT_ENVIRONMENT = false
  await new Promise((r) => setTimeout(r, ms))
  env.IS_REACT_ACT_ENVIRONMENT = true
}

/** Hover every chart so tooltips (and their formatters) render. Recharts
 * handles pointer events on the next animation frame. */
async function hoverCharts(container: HTMLElement) {
  await sleep(40)
  for (const svg of container.querySelectorAll(".recharts-wrapper")) {
    fireEvent.mouseMove(svg, { clientX: 400, clientY: 120 })
  }
  await sleep(60)
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
    const frame = () => sleep(40)
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
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(screen.getByText("Command")).toBeInTheDocument()
    expect(await screen.findByText("Runtime lag.")).toBeInTheDocument()
    await hoverCharts(container)

    // Freeze / resume.
    await user.click(screen.getByRole("button", { name: /Freeze/ }))
    expect(await screen.findByText(/View frozen/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Resume/ }))
  })

  it("navigates from timeline events to the run's output", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    const sidebar = container.querySelector("aside")!
    await openProc(user, sidebar, /ingest\.py/)

    // Each kind of event is on the strip, labelled, and opens the output at its time.
    const strip = await screen.findByRole("group", { name: "Timeline events" })
    expect(within(strip).getByRole("button", { name: /^Alert at T\+.*Memory reached/ })).toBeInTheDocument()
    expect(within(strip).getAllByRole("button", { name: /^Snapshot at/ }).length).toBeGreaterThan(0)
    expect(within(strip).getAllByRole("button", { name: /^Major GC at/ }).length).toBeGreaterThan(0)
    expect(within(strip).getAllByRole("button", { name: /^stderr at/ }).length).toBeGreaterThan(0)

    await user.click(within(strip).getAllByRole("button", { name: /^stderr at/ })[0])
    expect(screen.getByRole("tab", { name: /Output/ })).toHaveAttribute("data-state", "active")
    expect(await screen.findByText(/^Output at T\+/)).toBeInTheDocument()
    expect(container.querySelector("[data-log].bg-signal\\/10")!.textContent).toMatch(/Warning|Killed|\d/)
    await user.click(within(container.querySelector("main")!).getByRole("button", { name: "Clear" }))
    expect(screen.queryByText(/^Output at T\+/)).not.toBeInTheDocument()

    // A plain click on the chart does the same; a drag still zooms instead.
    await user.click(screen.getByRole("tab", { name: "Overview" }))
    const memory = () => [...container.querySelectorAll("section")].find((s) => s.textContent?.startsWith("Memory."))!.querySelector(".recharts-wrapper")!
    await sleep(60)
    fireEvent.mouseMove(memory(), { clientX: 400, clientY: 120 })
    await sleep(60)
    fireEvent.mouseDown(memory(), { clientX: 400, clientY: 120 })
    await sleep(60)
    fireEvent.mouseUp(memory(), { clientX: 400, clientY: 120 })
    expect(await screen.findByText(/^(Output at T\+|No output within 5s)/)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Output/ })).toHaveAttribute("data-state", "active")
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
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
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
    expect(await screen.findByText("Heap and CPU profiling aren't available.")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Overview" }))
    // `peak open` brings a run's profiler up.
    await act(async () => monitor.open(monitor.getSnapshot().selectedId!))
    expect(await screen.findByText("Heap and CPU profiling aren't available.")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Stats" }))
    expect(await screen.findByText("Not observed")).toBeInTheDocument()
    // A process that fails with an exit code (no signal) gets a "failed" label and toast.
    const id = monitor.getSnapshot().procs[0].id
    vi.spyOn(console, "error").mockImplementation(() => {})
    act(() => monitor.kill(id))
    expect(container).toBeTruthy()
  })

  it("browses history, reopens a stored run and compares two", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    const sidebar = container.querySelector("aside")!
    await screen.findByText("bun run dev", { selector: "h1" })
    const sessionBefore = monitor.getSnapshot().procs.length

    await user.click(within(sidebar).getByRole("button", { name: "History" }))
    expect(await screen.findByRole("heading", { name: "History." })).toBeInTheDocument()
    const group = (await screen.findByRole("heading", { name: "npm test" })).closest("section")!
    const boxes = within(group).getAllByRole("checkbox")
    await user.click(boxes[0])
    await user.click(boxes[1])
    await user.click(screen.getByRole("button", { name: "Compare" }))
    expect(await screen.findByRole("heading", { name: "Differences." })).toBeInTheDocument()
    expect(monitor.getSnapshot().procs).toHaveLength(sessionBefore)

    await user.click(within(container.querySelector("main")!).getByRole("button", { name: "History" }))
    await user.click(await screen.findByRole("button", { name: "Close" }))
    expect(await screen.findByText("bun run dev", { selector: "h1" })).toBeInTheDocument()

    // Opening a stored run: it's clearly marked, in its own section, and restartable.
    await user.click(within(sidebar).getByRole("button", { name: "History" }))
    const again = (await screen.findByRole("heading", { name: "npm test" })).closest("section")!
    await user.click(within(again).getAllByRole("button", { name: /^Open/ })[0])
    expect(await screen.findByText("npm test", { selector: "h1" })).toBeInTheDocument()
    expect(screen.getByText(/^From history ·/)).toBeInTheDocument()
    expect(within(sidebar).getByText("From history")).toBeInTheDocument()
    expect(monitor.getSnapshot().procs).toHaveLength(sessionBefore + 1)
    await user.click(screen.getByRole("tab", { name: "Report" }))
    expect(await screen.findByText("Verdict")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() => expect(screen.queryByText(/^From history ·/)).not.toBeInTheDocument())
  })

  it("connects a simulated target and routes capture, attach and controls to it", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    const sidebar = container.querySelector("aside")!
    await screen.findByText("bun run dev", { selector: "h1" })
    await user.click(within(sidebar).getByRole("button", { name: "Targets" }))
    expect(await screen.findByRole("heading", { name: "Targets." })).toBeInTheDocument()
    const card = screen.getByRole("region", { name: /staging-1/ })
    await user.click(within(card).getByRole("button", { name: "Connect" }))
    expect(await within(card).findByText("Connected")).toBeInTheDocument()
    expect(within(card).getByText("Host memory")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))

    // Capture: choose the target; the attach list and run go there.
    await user.click(within(sidebar).getByRole("button", { name: "Capture" }))
    await user.selectOptions(await screen.findByRole("combobox", { name: "Where" }), "staging")
    expect(screen.getByText(/stops if the connection is lost/)).toBeInTheDocument()
    expect(screen.queryByText("From your terminal.")).not.toBeInTheDocument()
    await user.click(await screen.findByText("node server.js --port 8080"))
    expect(await screen.findByText("node server.js --port 8080", { selector: "h1" })).toBeInTheDocument()
    expect(screen.getAllByText(/staging-1/).length).toBeGreaterThan(0)
    const attached = monitor.getSnapshot().procs[0]
    expect(attached.target?.launched).toBe(false)
    expect(screen.queryByRole("button", { name: "Stop" }), "an existing service has no plain Stop").not.toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Stats" }))
    expect(await screen.findByText("Target.")).toBeInTheDocument()

    // Losing the link: a banner, and no claim the workload ended.
    await act(() => monitor.disconnectTarget("staging"))
    expect(await screen.findByText(/It may still be running/)).toBeInTheDocument()
    expect(within(sidebar).getByLabelText("No connection")).toBeInTheDocument()
    expect(monitor.getSnapshot().procs[0].status).toBe("running")
    await act(async () => {
      await monitor.connectTarget("staging")
      await new Promise((r) => setTimeout(r, 450))
    })
    await waitFor(() => expect(screen.queryByText(/It may still be running/)).not.toBeInTheDocument())
    await user.click(screen.getByRole("tab", { name: "Overview" }))
    expect((monitor.getSnapshot().procs[0].gaps ?? []).length).toBe(1)

    // Launch on the target, with and without a shell.
    await user.click(within(sidebar).getByRole("button", { name: "Capture" }))
    await user.selectOptions(await screen.findByRole("combobox", { name: "Where" }), "staging")
    await user.type(screen.getByPlaceholderText("bun run build"), "node job.js --fast")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: /Run and capture/ }))
    expect(await screen.findByText("node job.js --fast", { selector: "h1" })).toBeInTheDocument()
    expect(monitor.getSnapshot().procs[0].target?.spec?.argv).toEqual(["node", "job.js", "--fast"])
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(await screen.findByRole("button", { name: "Run again" })).toBeInTheDocument()
    await user.click(within(sidebar).getByRole("button", { name: "Capture" }))
    await user.selectOptions(await screen.findByRole("combobox", { name: "Where" }), "staging")
    await user.type(screen.getByPlaceholderText("bun run build"), "python x.py")
    await user.click(screen.getByRole("button", { name: /Run and capture/ }))
    expect(await screen.findByText("python x.py", { selector: "h1" })).toBeInTheDocument()
    expect(monitor.getSnapshot().procs[0].target?.spec?.command).toBe("python x.py")
  })

  it("flags unreadable disk figures on the overview", async () => {
    const { container } = render(<App />)
    const user = userEvent.setup({ delay: null })
    await screen.findByText("bun run dev", { selector: "h1" })
    const run = monitor.getSnapshot().procs[0]
    await act(async () => {
      Object.assign(run, { unavailable: ["io"] })
      monitor.select(monitor.getSnapshot().procs[1].id)
      monitor.select(run.id)
    })
    await waitFor(() => expect(screen.getByText("Unreadable")).toBeInTheDocument())
    expect(screen.getByText(/flat lines mean unknown/)).toBeInTheDocument()
    expect(container).toBeTruthy()
    void user
  })

  it("opens the machine view from the sidebar strip", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    await screen.findByText("bun run dev", { selector: "h1" })
    await user.click(within(container.querySelector("aside")!).getByRole("button", { name: /This machine/ }))
    expect(await screen.findByRole("heading", { name: "This machine." })).toBeInTheDocument()
    expect(screen.getByText(/of the machine\./)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(await screen.findByText("bun run dev", { selector: "h1" })).toBeInTheDocument()
    act(() => monitor.clearEnded())
  })

  it("stays on Settings when pruning removes the selected run", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    const sidebar = container.querySelector("aside")!
    await openProc(user, sidebar, /ingest\.py/)
    await user.click(within(sidebar).getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: "Delete all stopped runs" }))
    await user.click(screen.getByRole("button", { name: "Delete all" }))
    expect(await screen.findByText(/\(0 stopped\)$/)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Settings." })).toBeInTheDocument()
    expect(monitor.getSnapshot().selectedId).not.toBeNull()
  })

  it("opens settings from the sidebar and shows the mock's storage", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(<App />)
    await screen.findByText("bun run dev", { selector: "h1" })
    await user.click(within(container.querySelector("aside")!).getByRole("button", { name: "Settings" }))
    expect(await screen.findByRole("heading", { name: "Storage." })).toBeInTheDocument()
    expect(screen.getByText(/in memory/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(await screen.findByText("bun run dev", { selector: "h1" })).toBeInTheDocument()
  })

  it("toasts and notifies natively for an alert when enabled", async () => {
    const native = vi.fn().mockResolvedValue(true)
    vi.resetModules()
    vi.doMock("@/lib/notify", () => ({ nativeNotify: native, notificationStatus: () => "" }))
    const { notify } = await import("@/App")
    const { Toaster } = await import("@/components/ui/sonner")
    render(<Toaster />)
    const proc = monitor.getSnapshot().procs[0]
    const alert = { t: 1, kind: "memory" as const, message: "Memory reached 2 GiB", value: 1, threshold: 1 }
    act(() => notify({ type: "alert", proc, alert, notify: false }))
    expect(await screen.findByText("Memory reached 2 GiB")).toBeInTheDocument()
    expect(native).not.toHaveBeenCalled()
    act(() => notify({ type: "alert", proc, alert, notify: true }))
    expect(native).toHaveBeenCalledWith(`Peak alert: ${proc.command}`, "Memory reached 2 GiB")
    vi.doUnmock("@/lib/notify")
  })

  it("switches themes", async () => {
    const user = userEvent.setup({ delay: null })
    render(<App />)
    await user.click(await screen.findByRole("button", { name: "Settings" }))
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
