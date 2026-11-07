import { formatBytes, formatCount, formatMs } from "@/lib/format"
import type { AgentCapability, Gauge, Proc, Runtime } from "@/lib/types"

export const RUNTIME_NAME: Record<Runtime, string> = {
  node: "Node.js",
  bun: "Bun",
  python: "Python",
  php: "PHP",
  go: "Go",
  rust: "Rust",
  shell: "This process",
}

export const CAPABILITY_LABEL: Record<AgentCapability, string> = {
  heap: "Live heap",
  gc: "Garbage collections",
  lag: "Runtime delay",
  cpu: "CPU profiles",
  snapshot: "Heap snapshots",
  forcegc: "Force collection",
}

export const CAPABILITIES = Object.keys(CAPABILITY_LABEL) as AgentCapability[]

/** Whether this run's agent offers something. Agents from before 0.1.1 didn't say, and offered all of it. */
export function can(proc: Proc, capability: AgentCapability) {
  return proc.agent ? proc.agent.capabilities.includes(capability) : true
}

/** Why an agent can't do something, in its own words. */
export function whyNot(proc: Proc, capability: string): string | undefined {
  return proc.agent?.unavailable?.[capability]
}

/** PHP counts collected values rather than bytes, and a zero there would read as nothing freed. */
export function freedIsReported(proc: Proc) {
  return !whyNot(proc, "gcFreed")
}

export function noCollectorText(proc: Proc) {
  if (proc.runtime === "rust") return "Rust frees memory deterministically — there is no collector to observe."
  return whyNot(proc, "gc") ?? "No collector data for this runtime."
}

export function formatGauge(gauge: Gauge) {
  switch (gauge.unit) {
    case "bytes":
      return formatBytes(gauge.value)
    case "percent":
      return `${gauge.value.toFixed(gauge.value < 1 ? 2 : 1)}%`
    case "ms":
      return formatMs(gauge.value)
    default:
      return formatCount(gauge.value)
  }
}

export interface AgentSetup {
  body: string
  code?: string
  then?: string
}

/** What it takes to get an agent for a runtime that doesn't have one here. */
export function setupFor(runtime: Runtime): AgentSetup {
  switch (runtime) {
    case "go":
      return {
        body: "A compiled program can't have anything injected into it, so Go programs opt in with one import. It does nothing outside Peak.",
        code: 'import _ "github.com/Noah-Wilderom/peak/sdk/go/auto"',
        then: "Rebuild, then start it from Capture or with peak run --. Run peak agents to see how to build against the copy included with Peak.",
      }
    case "bun":
      return {
        body: "Peak loads an agent into Bun when it starts the process. It needs Bun 1.2.15 or newer. Attaching to a running process only gives OS-level monitoring.",
        then: "Start it from Capture or with peak run --.",
      }
    case "php":
      return {
        body: "Peak loads an agent into command-line PHP when it starts the process. Attaching to a running process only gives OS-level monitoring. For more than figures at exit, install the Excimer extension.",
        code: "pecl install excimer",
        then: "Start it from Capture or with peak run --.",
      }
    case "node":
    case "python":
      return {
        body: `Peak loads an agent into ${RUNTIME_NAME[runtime]} when it starts the process. Attaching to a running process only gives OS-level monitoring.`,
        then: "Start it from Capture or with peak run --.",
      }
    default:
      return {
        body: "Peak has profiling agents for Node.js, Bun, Python, PHP and Go programs. If this command starts one of those, start it from Capture or with peak run --.",
      }
  }
}
