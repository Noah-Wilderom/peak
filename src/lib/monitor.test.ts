import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@tauri-apps/api/core")
})

describe("monitor selection", () => {
  it("uses the mock outside Tauri", async () => {
    const { monitor } = await import("@/lib/monitor")
    expect(monitor.mode).toBe("mock")
  })

  it("uses the backend inside Tauri", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }))
    const { monitor } = await import("@/lib/monitor")
    expect(monitor.mode).toBe("tauri")
  })
})
