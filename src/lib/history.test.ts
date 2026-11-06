import { describe, expect, it } from "vitest"
import { groupRuns, runOutcome, toggleSelection } from "@/lib/history"
import type { RunSummary } from "@/lib/types"

const run = (id: string, command: string): RunSummary => ({
  id, command, pid: 1, cwd: "/", runtime: "node", status: "exited", startedAt: 0, peakRss: 0, avgCpu: 0, samples: 0,
})

describe("history helpers", () => {
  it("groups by command, keeping the newest-first order of the input", () => {
    const groups = groupRuns([run("3", "b"), run("2", "a"), run("1", "b")])
    expect(groups.map((g) => g.command)).toEqual(["b", "a"])
    expect(groups[0].runs.map((r) => r.id)).toEqual(["3", "1"])
    expect(groupRuns([])).toEqual([])
  })

  it("says how a run ended, without claiming an exit for an interrupted one", () => {
    expect(runOutcome({ status: "running" })).toBe("Running")
    expect(runOutcome({ status: "exited", signal: "peak closed" })).toBe("Interrupted")
    expect(runOutcome({ status: "crashed", signal: "SIGKILL" })).toBe("Killed · SIGKILL")
    expect(runOutcome({ status: "crashed", exitCode: 2 })).toBe("Failed · exit 2")
    expect(runOutcome({ status: "exited", signal: "SIGINT" })).toBe("Stopped · SIGINT")
    expect(runOutcome({ status: "exited", exitCode: 0 })).toBe("Exited · 0")
    expect(runOutcome({ status: "exited" }), "an unknown exit code isn't printed").toBe("Ended")
    expect(runOutcome({ status: "exited", signal: "ended while disconnected" })).toBe("Ended while disconnected")
    expect(runOutcome({ status: "exited", signal: "target rebooted" })).toBe("Target rebooted")
    expect(runOutcome({ status: "exited", signal: "monitoring stopped" })).toBe("Monitoring stopped")
    expect(runOutcome({ status: "exited", signal: "stopped with the session" })).toBe("Stopped with the session")
  })

  it("limits selection to two and lets either be deselected", () => {
    expect(toggleSelection([], "a")).toEqual(["a"])
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"])
    expect(toggleSelection(["a", "b"], "c"), "a third pick changes nothing").toEqual(["a", "b"])
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"])
  })
})
