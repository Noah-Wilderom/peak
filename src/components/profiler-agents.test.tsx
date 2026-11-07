import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryTab } from "@/components/memory-tab"
import { TimelineProvider } from "@/components/charts/timeline"
import { ProfilerTab } from "@/components/profiler-tab"
import { StatsTab } from "@/components/stats-tab"
import { monitor, type AgentInfo, type HeapSnapshot, type Proc } from "@/lib/monitor"
import { makeProc } from "@/test/fixtures"

const PHP: AgentInfo = {
  runtimeVersion: "8.3.6",
  agentVersion: "0.1.1",
  capabilities: [],
  unavailable: { heap: "Install it: pecl install excimer", cpu: "CPU needs: pecl install excimer", snapshot: "PHP has no way to list memory.", forcegc: "GC needs: pecl install excimer" },
  notes: { gauges: "Figures from when the program ended." },
  gauges: [{ name: "Peak memory", value: 3 * 1024 ** 2, unit: "bytes" }],
}
const GO: AgentInfo = {
  runtimeVersion: "1.27.2",
  agentVersion: "0.1.1",
  capabilities: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"],
  notes: { snapshot: "Sampled allocation sites.", lag: "Scheduler wait, p99", heap: "From MemStats" },
  gauges: [{ name: "Goroutines", value: 12, unit: "count" }],
}
function MemoryDetailsForTest({ proc }: { proc: Proc }) {
  return (
    <TimelineProvider proc={proc} view={{ kind: "fixed", from: 1000, to: 1500 }} setView={() => {}} onJump={() => {}} axis="elapsed" paused>
      <MemoryTab totalMemory={1024} />
    </TimelineProvider>
  )
}

const snapshot = (over: Partial<HeapSnapshot> = {}): HeapSnapshot => ({
  id: "s1",
  t: 2000,
  heapUsed: 1024,
  entries: [{ name: "main.alloc", count: 2, shallow: 512, retained: 512 }],
  sites: { name: "(root)", self: 0, children: [{ name: "main.alloc", self: 512, children: [] }] },
  ...over,
})

afterEach(() => vi.restoreAllMocks())

describe("the Profiler with runtime agents", () => {
  it("names the runtime, agent and what it measures", () => {
    render(<ProfilerTab proc={makeProc({ runtime: "go", agent: GO })} />)
    const card = screen.getByRole("region", { name: "Runtime agent" })
    expect(card).toHaveTextContent("Go 1.27.2")
    expect(card).toHaveTextContent("Peak agent 0.1.1")
    expect(card).toHaveTextContent("Connected")
    expect(card).toHaveTextContent("CPU profiles")
    expect(card).toHaveTextContent("Goroutines12")
    expect(screen.getByText("Live heap")).toHaveAttribute("title", "From MemStats")
  })

  it("for a run with figures only at exit, shows them, disables what's missing and says how to get it", async () => {
    const user = userEvent.setup()
    render(<ProfilerTab proc={makeProc({ runtime: "php", agent: PHP, hasGc: false })} />)
    const card = screen.getByRole("region", { name: "Runtime agent" })
    expect(card).toHaveTextContent("PHP 8.3.6")
    expect(card).toHaveTextContent("Peak memory3 MiB")
    expect(card).toHaveTextContent("Figures from when the program ended.")
    expect(card).toHaveTextContent("Install it: pecl install excimer")
    // Nothing to snapshot, so it opens on CPU, which says why it can't record.
    expect(screen.getByRole("button", { name: "Record 5s" })).toBeDisabled()
    expect(screen.getAllByText("CPU needs: pecl install excimer")).toHaveLength(2)
    await user.click(screen.getByRole("radio", { name: "Heap" }))
    expect(screen.getByRole("button", { name: /Take snapshot/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Collect garbage/ })).toBeDisabled()
    expect(screen.getAllByText("PHP has no way to list memory.").length).toBeGreaterThan(0)
    expect(screen.getByText("No heap snapshots here.")).toBeInTheDocument()
    expect(screen.queryByText(/Take a heap snapshot to see/)).not.toBeInTheDocument()
  })

  it("falls back on wording of its own when an agent gives no reason", async () => {
    const user = userEvent.setup()
    const agent = { runtimeVersion: "1", agentVersion: "1", capabilities: [] }
    render(<ProfilerTab proc={makeProc({ runtime: "php", agent })} />)
    expect(screen.getByText("This agent can't record CPU profiles.")).toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "Heap" }))
    expect(screen.getByText("This agent can't take heap snapshots.")).toBeInTheDocument()
  })

  it("keeps showing what an agent reported after it's gone, without offering actions", () => {
    render(<ProfilerTab proc={makeProc({ runtime: "go", agent: GO, profiling: false, status: "exited" })} />)
    expect(screen.getByRole("region", { name: "Runtime agent" })).toHaveTextContent("Agent has disconnected")
    expect(screen.getByRole("button", { name: /Take snapshot/ })).toBeDisabled()
  })

  it("calls Go's snapshot entries functions, and uses the agent's explanation", async () => {
    render(<ProfilerTab proc={makeProc({ runtime: "go", agent: GO, snapshots: [snapshot()] })} />)
    expect(screen.getByText("Heap by allocating function.")).toBeInTheDocument()
    expect(screen.getByText("Sampled allocation sites.")).toBeInTheDocument()
    expect(screen.getByText("Function")).toBeInTheDocument()
    expect(screen.getByText("1 functions")).toBeInTheDocument()
    expect(screen.getByText("Allocation sites.")).toBeInTheDocument()
  })

  it("doesn't draw allocation sites an agent has none of", () => {
    const sites = { name: "(root)", self: 0, children: [] }
    render(<ProfilerTab proc={makeProc({ runtime: "bun", agent: { ...GO, notes: {} }, snapshots: [snapshot({ sites })] })} />)
    expect(screen.queryByText("Allocation sites.")).not.toBeInTheDocument()
    expect(screen.getByText("Heap by type.")).toBeInTheDocument()
    expect(screen.getByText("Constructor")).toBeInTheDocument()
  })

  it("shows a snapshot failure rather than swallowing it", async () => {
    const user = userEvent.setup()
    vi.spyOn(monitor, "takeSnapshot").mockRejectedValue("agent did not answer in time")
    render(<ProfilerTab proc={makeProc({ runtime: "go", agent: GO })} />)
    await act(() => user.click(screen.getByRole("button", { name: /Take snapshot/ })))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("agent did not answer in time"))
  })

  it("explains each profile by how it was measured", async () => {
    const user = userEvent.setup()
    const root = { name: "(root)", self: 0, children: [] }
    const profile = (id: string, sampling: "pprof" | "jsc" | "excimer-cpu" | "excimer-wall") => ({ id, t: 2000, durationMs: 1000, sampling, root })
    render(<ProfilerTab proc={makeProc({ agent: { ...GO, capabilities: ["cpu"] }, cpuProfiles: [profile("a", "pprof"), profile("b", "jsc"), profile("c", "excimer-cpu"), profile("d", "excimer-wall")] })} />)
    expect(screen.getByText(/Elapsed time sampled by Excimer/)).toBeInTheDocument()
    await user.click(screen.getByText("Profile 3"))
    expect(screen.getByText(/On-CPU time sampled by Excimer/)).toBeInTheDocument()
    await user.click(screen.getByText("Profile 2"))
    expect(screen.getByText(/Sampled by JavaScriptCore/)).toBeInTheDocument()
    await user.click(screen.getByText("Profile 1"))
    expect(screen.getByText(/all goroutines/)).toBeInTheDocument()
  })

  it("gives each runtime its own setup when there's no agent", () => {
    render(<ProfilerTab proc={makeProc({ runtime: "go", profiling: false })} />)
    expect(screen.getByText("Heap and CPU profiling aren't available.")).toBeInTheDocument()
    expect(screen.getByText('import _ "github.com/Noah-Wilderom/peak/sdk/go/auto"')).toBeInTheDocument()
  })
})

describe("collections without byte counts", () => {
  const unreported = makeProc({
    runtime: "php",
    gc: [{ t: 1200, kind: "major", pauseMs: 2, freed: 0 }],
    agent: { runtimeVersion: "8.3", agentVersion: "1", capabilities: ["gc"], unavailable: { gcFreed: "PHP counts values." } },
  })

  it("aren't shown as nothing reclaimed", () => {
    const system = { totalMemory: 1024, cpuCount: 1 } as never
    render(<StatsTab proc={unreported} system={system} />)
    expect(screen.getByText("Not reported")).toBeInTheDocument()
  })

  it("say so on the Memory tab", () => {
    render(<MemoryDetailsForTest proc={unreported} />)
    expect(screen.getByText("Not reported").parentElement).toHaveAttribute("title", "PHP counts values.")
  })

  it("the Memory tab gives the agent's reason for having no collector data", () => {
    const agent = { runtimeVersion: "1", agentVersion: "1", capabilities: [], unavailable: { gc: "Bun doesn't publish them." } }
    render(<MemoryDetailsForTest proc={makeProc({ runtime: "bun", hasGc: false, agent })} />)
    expect(screen.getAllByText("Bun doesn't publish them.").length).toBe(2)
  })
})
