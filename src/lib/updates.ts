import { invoke, isTauri } from "@tauri-apps/api/core"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { monitor } from "@/lib/monitor"

/** How this copy was installed, which decides whether it can update itself. */
export type InstallKind = "appimage" | "app" | "nsis" | "msi" | "deb" | "rpm" | "source" | "browser"

export interface InstallInfo {
  version: string
  commit: string
  kind: InstallKind
  updatable: boolean
}

export type UpdateStage =
  | { stage: "idle" }
  | { stage: "checking" }
  | { stage: "current" }
  | { stage: "available"; version: string; notes: string }
  | { stage: "downloading"; version: string; done: number; total: number | null }
  | { stage: "installing"; version: string }
  | { stage: "ready"; version: string }
  | { stage: "failed"; during: "check" | "install" | "restart"; message: string; version?: string }

export type UpdateState = UpdateStage & { info: InstallInfo | null }

export interface UpdateDeps {
  info: () => Promise<InstallInfo>
  check: () => Promise<Update | null>
  relaunch: () => Promise<void>
  running: () => Promise<string[]>
  enabled: () => Promise<boolean>
}

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 3_600_000

/** Says what a failure means for the user's copy, keeping the cause. */
function explain(e: unknown) {
  const raw = String(e)
  return /signature|minisign/i.test(raw)
    ? `The download failed its signature check, so nothing was installed. (${raw})`
    : raw
}

/**
 * The update flow. Finding a release is automatic. Downloading and restarting always
 * wait for the user, because a restart stops the commands this app started.
 */
export class Updates {
  private state: UpdateState = { stage: "idle", info: null }
  private listeners = new Set<() => void>()
  private update: Update | null = null
  private deps: UpdateDeps

  constructor(deps: UpdateDeps) {
    this.deps = deps
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  getSnapshot = () => this.state

  private set(stage: UpdateStage) {
    this.state = { ...stage, info: this.state.info }
    this.listeners.forEach((l) => l())
  }

  /** Learn what this copy is, then keep looking for releases if it can use them. */
  start() {
    let stopped = false
    let timers: ReturnType<typeof setTimeout>[] = []
    const auto = () =>
      void this.deps.enabled().then(
        (on) => (on ? this.checkNow(true) : undefined),
        () => {},
      )
    void this.deps.info().then(
      (info) => {
        this.state = { ...this.state, info }
        this.listeners.forEach((l) => l())
        if (!stopped && info.updatable) timers = [setTimeout(auto, FIRST_CHECK_MS), setInterval(auto, CHECK_EVERY_MS)]
      },
      () => {},
    )
    return () => {
      stopped = true
      timers.forEach(clearTimeout)
    }
  }

  private get busy() {
    return ["checking", "downloading", "installing", "ready"].includes(this.state.stage)
  }

  /** A background check that fails stays quiet: being offline isn't worth interrupting for. */
  async checkNow(auto = false) {
    if (this.busy) return
    const before = this.state
    this.set({ stage: "checking" })
    try {
      const update = await this.deps.check()
      this.update = update
      this.set(update ? { stage: "available", version: update.version, notes: update.body ?? "" } : { stage: "current" })
    } catch (e) {
      // Keep an update already on offer if a later background check can't get through.
      if (auto && before.stage === "available") this.set(before)
      else this.set({ stage: "failed", during: "check", message: String(e) })
    }
  }

  async install() {
    const update = this.update
    if (!update || this.busy) return
    const version = update.version
    let done = 0
    let total: number | null = null
    this.set({ stage: "downloading", version, done, total })
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? null
        if (ev.event === "Progress") done += ev.data.chunkLength
        if (ev.event === "Finished") this.set({ stage: "installing", version })
        else this.set({ stage: "downloading", version, done, total })
      })
      this.set({ stage: "ready", version })
    } catch (e) {
      this.set({ stage: "failed", during: "install", message: explain(e), version })
    }
  }

  /** Commands a restart would stop. */
  running = () => this.deps.running()

  async restart() {
    try {
      await this.deps.relaunch()
    } catch (e) {
      const version = this.state.stage === "ready" ? this.state.version : undefined
      this.set({ stage: "failed", during: "restart", message: String(e), version })
    }
  }
}

export const browserInfo: InstallInfo = { version: "", commit: "", kind: "browser", updatable: false }

export const defaultDeps: UpdateDeps = {
  info: () => (isTauri() ? invoke<InstallInfo>("install_info") : Promise.resolve(browserInfo)),
  check: () => check({ timeout: 30_000 }),
  relaunch,
  running: () => invoke<string[]>("running_captures"),
  enabled: () => monitor.getSettings().then((s) => s.checkForUpdates),
}

export const updates = new Updates(defaultDeps)
