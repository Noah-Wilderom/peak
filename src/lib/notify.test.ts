import { afterEach, describe, expect, it, vi } from "vitest"

const plugin = { isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }

async function load(tauri: boolean) {
  vi.resetModules()
  vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => tauri }))
  vi.doMock("@tauri-apps/plugin-notification", () => plugin)
  return import("@/lib/notify")
}

function browserNotification(permission: string, ask = permission) {
  const N = vi.fn() as unknown as { permission: string; requestPermission: () => Promise<string> }
  N.permission = permission
  N.requestPermission = vi.fn(async () => ask)
  vi.stubGlobal("Notification", N)
  return N
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.doUnmock("@tauri-apps/api/core")
  vi.doUnmock("@tauri-apps/plugin-notification")
})

describe("nativeNotify (desktop)", () => {
  it("sends when permitted, asking first if needed", async () => {
    const { nativeNotify, notificationStatus } = await load(true)
    expect(notificationStatus()).toMatch(/can't see whether it appears/)
    plugin.isPermissionGranted.mockResolvedValueOnce(true)
    expect(await nativeNotify("t", "b")).toBe(true)
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "t", body: "b" })
    plugin.isPermissionGranted.mockResolvedValueOnce(false)
    plugin.requestPermission.mockResolvedValueOnce("granted")
    expect(await nativeNotify("t", "b")).toBe(true)
  })

  it("stays quiet when refused or when the service fails", async () => {
    const { nativeNotify } = await load(true)
    plugin.isPermissionGranted.mockResolvedValueOnce(false)
    plugin.requestPermission.mockResolvedValueOnce("denied")
    expect(await nativeNotify("t", "b")).toBe(false)
    expect(plugin.sendNotification).not.toHaveBeenCalled()
    plugin.isPermissionGranted.mockRejectedValueOnce(new Error("no dbus"))
    expect(await nativeNotify("t", "b"), "monitoring never sees the failure").toBe(false)
  })
})

describe("nativeNotify (browser mock)", () => {
  it("uses web notifications when allowed", async () => {
    const { nativeNotify, notificationStatus } = await load(false)
    const N = browserNotification("granted")
    expect(notificationStatus()).toMatch(/browser notifications/)
    expect(await nativeNotify("t", "b")).toBe(true)
    expect(N).toHaveBeenCalledWith("t", { body: "b" })
    browserNotification("default", "granted")
    expect(await nativeNotify("t", "b")).toBe(true)
  })

  it("handles refusal and missing support", async () => {
    const { nativeNotify, notificationStatus } = await load(false)
    const N = browserNotification("denied")
    expect(notificationStatus()).toMatch(/Blocked/)
    expect(await nativeNotify("t", "b")).toBe(false)
    expect(N).not.toHaveBeenCalled()
    vi.stubGlobal("Notification", undefined)
    expect(notificationStatus()).toMatch(/Not supported/)
    expect(await nativeNotify("t", "b")).toBe(false)
  })
})
