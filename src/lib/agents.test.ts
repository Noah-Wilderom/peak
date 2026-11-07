import { describe, expect, it } from "vitest"
import { can, formatGauge, freedIsReported, noCollectorText, setupFor, whyNot } from "@/lib/agents"
import { makeProc } from "@/test/fixtures"

describe("agent facts", () => {
  it("takes an agent's word for what it can do, and assumes an older one can do it all", () => {
    expect(can(makeProc(), "snapshot")).toBe(true)
    const agent = { runtimeVersion: "8.3", agentVersion: "0.1.1", capabilities: ["cpu" as const], unavailable: { snapshot: "No way to list memory.", gcFreed: "Counts values." } }
    const php = makeProc({ runtime: "php", agent })
    expect(can(php, "cpu")).toBe(true)
    expect(can(php, "snapshot")).toBe(false)
    expect(whyNot(php, "snapshot")).toBe("No way to list memory.")
    expect(whyNot(makeProc(), "snapshot")).toBeUndefined()
    expect(freedIsReported(php)).toBe(false)
    expect(freedIsReported(makeProc())).toBe(true)
  })

  it("says why there's no collector data", () => {
    expect(noCollectorText(makeProc({ runtime: "rust" }))).toMatch(/deterministically/)
    expect(noCollectorText(makeProc({ runtime: "shell" }))).toMatch(/No collector data/)
    const agent = { runtimeVersion: "1", agentVersion: "1", capabilities: [], unavailable: { gc: "Bun doesn't publish them." } }
    expect(noCollectorText(makeProc({ runtime: "bun", agent }))).toBe("Bun doesn't publish them.")
  })

  it("formats gauges in their units", () => {
    expect(formatGauge({ name: "a", value: 2048, unit: "bytes" })).toBe("2 KiB")
    expect(formatGauge({ name: "a", value: 0.5, unit: "percent" })).toBe("0.50%")
    expect(formatGauge({ name: "a", value: 12.34, unit: "percent" })).toBe("12.3%")
    expect(formatGauge({ name: "a", value: 12, unit: "ms" })).toMatch(/12/)
    expect(formatGauge({ name: "a", value: 12, unit: "count" })).toBe("12")
  })

  it("tells each runtime how to get an agent, without promising to attach", () => {
    expect(setupFor("go").code).toContain("sdk/go/auto")
    expect(setupFor("go").body).toMatch(/can't have anything injected/)
    expect(setupFor("bun").body).toMatch(/1\.2\.15/)
    expect(setupFor("php").code).toBe("pecl install excimer")
    for (const runtime of ["node", "python", "bun", "php"] as const) expect(setupFor(runtime).body).toMatch(/can't be attached to/)
    expect(setupFor("python").body).toMatch(/Python/)
    expect(setupFor("shell").code).toBeUndefined()
  })
})
