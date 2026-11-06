import { updates } from "@/lib/updates"

/** One go at check, install and restart, with nobody there. Only reachable from update-proof builds. */
export async function updateProofPass() {
  await updates.checkNow()
  await updates.install()
  if (updates.getSnapshot().stage === "ready") await updates.restart()
}
