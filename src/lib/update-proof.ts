import { monitor } from "@/lib/monitor"
import { updates } from "@/lib/updates"

/**
 * There's no way to read this window on every OS, so each new failure is written where the
 * harness can read it: as the output of a command, in the app's own history.
 */
export function recordProofFailures() {
  let last = ""
  updates.subscribe(() => {
    const s = updates.getSnapshot()
    if (s.stage !== "failed" || s.message === last) return
    last = s.message
    void monitor.capture(`echo update-proof-failure ${btoa(JSON.stringify({ during: s.during, message: s.message }))}`, "~")
  })
}

/** One go at check, install and restart, with nobody there. Only reachable from update-proof builds. */
export async function updateProofPass() {
  await updates.checkNow()
  await updates.install()
  if (updates.getSnapshot().stage === "ready") await updates.restart()
}
