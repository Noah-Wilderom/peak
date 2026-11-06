import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Update } from "@tauri-apps/plugin-updater"
import { updateProofPass } from "@/lib/update-proof"
import { Updates, browserInfo, defaultDeps, updates as shared, type InstallInfo, type UpdateDeps } from "@/lib/updates"
import { monitor } from "@/lib/monitor"

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }))
vi.mock("@tauri-apps/api/core", async (real) => ({ ...(await real<object>()), isTauri: vi.fn(() => false), invoke: vi.fn(async () => ["cmd"]) }))

const appimage: InstallInfo = { version: "0.1.0", commit: "abc", kind: "appimage", updatable: true }

type Event = Parameters<Parameters<Update["downloadAndInstall"]>[0] & object>[0]

function fakeUpdate(install: (cb: (e: Event) => void) => Promise<void> = async () => {}, body: string | null = "notes") {
  const run = vi.fn((cb: (e: Event) => void) => install(cb))
  return { version: "0.2.0", body, downloadAndInstall: run, download: run, install: vi.fn(async () => {}) } as unknown as Update
}

function setup(over: Partial<UpdateDeps> = {}) {
  const deps: UpdateDeps = {
    info: vi.fn(async () => appimage),
    check: vi.fn(async () => null),
    relaunch: vi.fn(async () => {}),
    running: vi.fn(async () => []),
    prepareRestart: vi.fn(async () => {}),
    enabled: vi.fn(async () => true),
    ...over,
  }
  return { deps, u: new Updates(deps) }
}

describe("Updates", () => {
  it("reports each outcome of a check", async () => {
    const { u, deps } = setup()
    const seen: string[] = []
    const off = u.subscribe(() => seen.push(u.getSnapshot().stage))
    await u.checkNow()
    expect(seen).toEqual(["checking", "current"])
    off()
    vi.mocked(deps.check).mockResolvedValueOnce(fakeUpdate())
    await u.checkNow()
    expect(u.getSnapshot()).toMatchObject({ stage: "available", version: "0.2.0", notes: "notes" })
    vi.mocked(deps.check).mockResolvedValueOnce(fakeUpdate(undefined, null))
    await u.checkNow()
    expect(u.getSnapshot()).toMatchObject({ stage: "available", notes: "" })
    expect(seen).toHaveLength(2)
  })

  it("says when a check fails, but keeps an offer through a background failure", async () => {
    const { u, deps } = setup()
    vi.mocked(deps.check).mockRejectedValueOnce("offline")
    await u.checkNow(true)
    expect(u.getSnapshot()).toMatchObject({ stage: "failed", during: "check", message: "offline" })
    vi.mocked(deps.check).mockResolvedValueOnce(fakeUpdate())
    await u.checkNow()
    vi.mocked(deps.check).mockRejectedValueOnce("offline")
    await u.checkNow(true)
    expect(u.getSnapshot()).toMatchObject({ stage: "available", version: "0.2.0" })
    vi.mocked(deps.check).mockRejectedValueOnce("offline")
    await u.checkNow()
    expect(u.getSnapshot()).toMatchObject({ stage: "failed", during: "check" })
  })

  it("shows progress through download, verification and install, and then waits", async () => {
    const stages: unknown[] = []
    const update = fakeUpdate(async (cb) => {
      cb({ event: "Started", data: { contentLength: 100 } })
      stages.push(u.getSnapshot())
      cb({ event: "Progress", data: { chunkLength: 40 } })
      stages.push(u.getSnapshot())
      cb({ event: "Finished" })
      stages.push(u.getSnapshot())
    })
    const { u, deps } = setup({ check: vi.fn(async () => update) })
    await u.checkNow()
    await u.install()
    expect(stages).toEqual([
      expect.objectContaining({ stage: "downloading", done: 0, total: 100 }),
      expect.objectContaining({ stage: "downloading", done: 40, total: 100 }),
      expect.objectContaining({ stage: "installing", version: "0.2.0" }),
    ])
    expect(u.getSnapshot()).toMatchObject({ stage: "ready", version: "0.2.0", pending: false })
    expect(deps.relaunch).not.toHaveBeenCalled()
    // Nothing more to look for until it's restarted.
    await u.checkNow()
    expect(deps.check).toHaveBeenCalledTimes(1)
    await u.install()
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  })

  it("on Windows, only installs at the restart, after stopping what it would stop", async () => {
    const calls: string[] = []
    const update = fakeUpdate(async (cb) => cb({ event: "Finished" }))
    vi.mocked(update.install).mockImplementation(async () => void calls.push("install"))
    const { u, deps } = setup({
      info: vi.fn(async () => ({ ...appimage, kind: "nsis" as const })),
      check: vi.fn(async () => update),
      prepareRestart: vi.fn(async () => void calls.push("prepare")),
      relaunch: vi.fn(async () => void calls.push("relaunch")),
    })
    u.start()()
    await vi.waitFor(() => expect(u.getSnapshot().info?.kind).toBe("nsis"))
    await u.checkNow()
    await u.install()
    expect(u.getSnapshot()).toMatchObject({ stage: "ready", pending: true })
    expect(update.download).toHaveBeenCalled()
    expect(update.install).not.toHaveBeenCalled()
    expect(deps.prepareRestart).not.toHaveBeenCalled()
    await u.restart()
    expect(calls).toEqual(["prepare", "install", "relaunch"])
  })

  it("copes with an unknown download size", async () => {
    const update = fakeUpdate(async (cb) => cb({ event: "Started", data: {} }))
    const { u } = setup({ check: vi.fn(async () => update) })
    await u.checkNow()
    let total: unknown = "unset"
    u.subscribe(() => {
      const s = u.getSnapshot()
      if (s.stage === "downloading") total = s.total
    })
    await u.install()
    expect(total).toBeNull()
  })

  it("has nothing to install before a check finds something", async () => {
    const { u } = setup()
    await u.install()
    expect(u.getSnapshot().stage).toBe("idle")
  })

  it("explains a bad signature and other install failures", async () => {
    const bad = fakeUpdate(async () => {
      throw "the signature was invalid"
    })
    const { u, deps } = setup({ check: vi.fn(async () => bad) })
    await u.checkNow()
    await u.install()
    const failed = u.getSnapshot()
    expect(failed).toMatchObject({ stage: "failed", during: "install", version: "0.2.0" })
    expect(failed).toHaveProperty("message", expect.stringContaining("failed its signature check, so nothing was installed"))

    vi.mocked(deps.check).mockResolvedValueOnce(
      fakeUpdate(async () => {
        throw "disk full"
      }),
    )
    await u.checkNow()
    await u.install()
    expect(u.getSnapshot()).toMatchObject({ stage: "failed", message: "disk full" })
  })

  it("restarts only when told, and says if it couldn't", async () => {
    const { u, deps } = setup({ check: vi.fn(async () => fakeUpdate()) })
    await u.restart()
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
    await u.checkNow()
    await u.install()
    vi.mocked(deps.relaunch).mockRejectedValueOnce("no")
    await u.restart()
    expect(u.getSnapshot()).toMatchObject({ stage: "failed", during: "restart", version: "0.2.0", message: "no" })
    vi.mocked(deps.relaunch).mockRejectedValueOnce("no")
    await u.restart()
    expect(u.getSnapshot()).toMatchObject({ stage: "failed", during: "restart", message: "no" })
    expect(u.getSnapshot()).toHaveProperty("version", undefined)
    await expect(u.running()).resolves.toEqual([])
  })

  describe("background checks", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const settle = () => vi.advanceTimersByTimeAsync(0)

    it("look soon after starting and then every six hours, while allowed", async () => {
      const { u, deps } = setup()
      const stop = u.start()
      await settle()
      expect(u.getSnapshot().info).toEqual(appimage)
      expect(deps.check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(deps.check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6 * 3_600_000)
      expect(deps.check).toHaveBeenCalledTimes(2)
      vi.mocked(deps.enabled).mockResolvedValue(false)
      await vi.advanceTimersByTimeAsync(6 * 3_600_000)
      expect(deps.check).toHaveBeenCalledTimes(2)
      vi.mocked(deps.enabled).mockRejectedValue("db")
      await vi.advanceTimersByTimeAsync(6 * 3_600_000)
      expect(deps.check).toHaveBeenCalledTimes(2)
      stop()
      vi.mocked(deps.enabled).mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(6 * 3_600_000)
      expect(deps.check).toHaveBeenCalledTimes(2)
    })

    it("don't run for a copy that can't update itself, or that stopped first", async () => {
      const source = setup({ info: vi.fn(async () => ({ ...appimage, kind: "source" as const, updatable: false })) })
      source.u.start()
      await settle()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(source.deps.check).not.toHaveBeenCalled()

      const stopped = setup()
      stopped.u.start()()
      await settle()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(stopped.deps.check).not.toHaveBeenCalled()
    })

    it("survive not learning what this copy is", async () => {
      const { u } = setup({ info: vi.fn(async () => Promise.reject("no")) })
      u.start()
      await settle()
      expect(u.getSnapshot().info).toBeNull()
    })
  })
})

describe("the real dependencies", () => {
  it("call the updater, the process plugin and the backend", async () => {
    const { check } = await import("@tauri-apps/plugin-updater")
    const { relaunch } = await import("@tauri-apps/plugin-process")
    const { invoke } = await import("@tauri-apps/api/core")
    await defaultDeps.check()
    expect(check).toHaveBeenCalledWith({ timeout: 30_000 })
    await defaultDeps.relaunch()
    expect(relaunch).toHaveBeenCalled()
    await expect(defaultDeps.running()).resolves.toEqual(["cmd"])
    await defaultDeps.prepareRestart()
    expect(invoke).toHaveBeenCalledWith("prepare_restart")
    expect(invoke).toHaveBeenCalledWith("running_captures")
    const settings = vi.spyOn(monitor, "getSettings").mockResolvedValue({ checkForUpdates: false } as never)
    await expect(defaultDeps.enabled()).resolves.toBe(false)
    settings.mockRestore()
  })

  it("ask the backend what this copy is when inside the app", async () => {
    const { invoke, isTauri } = await import("@tauri-apps/api/core")
    vi.mocked(isTauri).mockReturnValueOnce(true)
    await defaultDeps.info()
    expect(invoke).toHaveBeenCalledWith("install_info")
  })
})

describe("the shared instance", () => {
  it("is the browser demo outside the app", async () => {
    const stop = shared.start()
    await vi.waitFor(() => expect(shared.getSnapshot().info).toEqual(browserInfo))
    stop()
  })
})

describe("updateProofPass", () => {
  it("restarts only after a good install", async () => {
    const check = vi.spyOn(shared, "checkNow").mockResolvedValue()
    const install = vi.spyOn(shared, "install").mockResolvedValue()
    const restart = vi.spyOn(shared, "restart").mockResolvedValue()
    const snapshot = vi.spyOn(shared, "getSnapshot").mockReturnValue({ stage: "ready", version: "2", pending: false, info: null })
    await updateProofPass()
    expect(restart).toHaveBeenCalledTimes(1)
    snapshot.mockReturnValue({ stage: "current", info: null })
    await updateProofPass()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })
})
