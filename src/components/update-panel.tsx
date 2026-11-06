import { useState, useSyncExternalStore } from "react"
import { AnimatePresence, motion } from "motion/react"
import { DownloadIcon, RotateCwIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { formatBytes } from "@/lib/format"
import { updates, type InstallKind, type UpdateState } from "@/lib/updates"

export const RELEASES_URL = "https://github.com/Noah-Wilderom/peak/releases"

export function useUpdates() {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot)
}

/** What each kind of install does about updates. */
export const UPDATE_SUPPORT: Record<Exclude<InstallKind, "appimage" | "app" | "nsis">, string> = {
  msi: `Installed from an MSI, which doesn't update itself here. Use the installer from ${RELEASES_URL} to get updates.`,
  deb: `Installed from a .deb package, which doesn't update itself. Install the next .deb from ${RELEASES_URL}.`,
  rpm: `Installed from an rpm package, which doesn't update itself. Install the next package from ${RELEASES_URL}.`,
  source: `Built from source, so it doesn't update itself. To get updates, install a release from ${RELEASES_URL}.`,
  browser: "This is the browser demo, with simulated data. There's no app here to update.",
}

/** Restarting stops what this app started, so that's said first, with the names. */
function RestartButton() {
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const ask = async () => {
    const running = await updates.running().catch(() => [])
    if (running.length) setConfirm(running)
    else await updates.restart()
  }
  if (!confirm) {
    return (
      <Button size="sm" onClick={() => void ask()}>
        <RotateCwIcon /> Restart now
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">Restarting stops {confirm.length === 1 ? "this command" : `these ${confirm.length} commands`}:</p>
      <ul className="max-h-24 overflow-y-auto font-mono text-xs text-muted-foreground">
        {confirm.map((c, i) => (
          <li key={i} className="truncate">{c}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Commands from `peak run` and attached processes keep running. History and settings are kept.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void updates.restart()}>Stop and restart</Button>
        <Button size="sm" variant="secondary" onClick={() => setConfirm(null)}>Not now</Button>
      </div>
    </div>
  )
}

/** The current step of an update, for both the settings card and the notice. */
export function UpdateProgress({ state }: { state: UpdateState }) {
  switch (state.stage) {
    case "available":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Peak {state.version} is available.</p>
          {state.notes && <p className="max-h-32 overflow-y-auto text-xs whitespace-pre-line text-muted-foreground">{state.notes}</p>}
          <div>
            <Button size="sm" onClick={() => void updates.install()}>
              <DownloadIcon /> Download and install
            </Button>
          </div>
        </div>
      )
    case "downloading":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Downloading Peak {state.version}…</p>
          <Progress value={state.total ? (state.done / state.total) * 100 : null} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(state.done)}
            {state.total ? ` of ${formatBytes(state.total)}` : ""}
          </p>
        </div>
      )
    case "installing":
      return <p className="text-sm font-semibold">Verifying Peak {state.version}…</p>
    case "ready":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Peak {state.version} is {state.pending ? "downloaded and verified" : "installed"}.</p>
          <p className="text-xs text-muted-foreground">
            {state.pending ? "It installs when you restart." : "It starts the next time Peak does."} Nothing restarts until you say so.
          </p>
          <div>
            <RestartButton />
          </div>
        </div>
      )
    case "failed":
      if (state.during === "restart") {
        return (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-danger">Peak couldn't restart.</p>
            <p className="text-xs text-muted-foreground">The update is installed. Close and reopen Peak to use it. ({state.message})</p>
          </div>
        )
      }
      if (state.during === "install") {
        return (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-danger">Peak {state.version} couldn't be installed.</p>
            <p className="text-xs break-words text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">This copy of Peak is unchanged and keeps working.</p>
            <div>
              <Button size="sm" variant="secondary" onClick={() => void updates.checkNow()}>Check again</Button>
            </div>
          </div>
        )
      }
      return <p className="text-xs break-words text-muted-foreground">Couldn't check for updates: {state.message}</p>
    case "checking":
      return <p className="text-xs text-muted-foreground">Checking for updates…</p>
    case "current":
      return <p className="text-xs text-muted-foreground">This is the latest version.</p>
    default:
      return null
  }
}

function noticeWorthy(state: UpdateState) {
  return !(state.stage === "idle" || state.stage === "checking" || state.stage === "current" || (state.stage === "failed" && state.during === "check"))
}

/** Appears over the app when there's something to decide. Never takes any action itself. */
export function UpdateNotice() {
  const state = useUpdates()
  const [hidden, setHidden] = useState<string | null>(null)
  const key = state.stage === "available" ? state.version : null
  const show = noticeWorthy(state) && !(key && key === hidden)
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          role="status"
          aria-label="Peak update"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="fixed right-6 bottom-6 z-40 w-[340px] rounded-card border border-border bg-background p-4 shadow-lg"
        >
          {key && (
            <button aria-label="Later" onClick={() => setHidden(key)} className="absolute top-3 right-3 text-muted-foreground hover:text-foreground">
              <XIcon className="size-4" />
            </button>
          )}
          <UpdateProgress state={state} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The update section of Settings. */
export function UpdateSection() {
  const state = useUpdates()
  const info = state.info
  if (!info) return null
  if (info.kind !== "appimage" && info.kind !== "app" && info.kind !== "nsis") {
    return (
      <div className="flex flex-col gap-2">
        {info.version && <VersionLine version={info.version} commit={info.commit} />}
        <p className="text-sm text-muted-foreground">{UPDATE_SUPPORT[info.kind]}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <VersionLine version={info.version} commit={info.commit} />
      <UpdateProgress state={state} />
      <div>
        <Button size="sm" variant="secondary" disabled={!["idle", "current", "failed", "available"].includes(state.stage)} onClick={() => void updates.checkNow()}>
          Check for updates
        </Button>
      </div>
    </div>
  )
}

function VersionLine({ version, commit }: { version: string; commit: string }) {
  return (
    <p className="text-sm">
      <span className="font-semibold">Peak {version}</span> <span className="font-mono text-xs text-muted-foreground select-text">{commit.slice(0, 12)}</span>
    </p>
  )
}
