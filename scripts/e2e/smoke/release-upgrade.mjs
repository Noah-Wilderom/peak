#!/usr/bin/env node
// One published release updating to the next, exactly as a user's would: the older release's own
// files from its public URLs, its own update check against GitHub's feed, its own buttons pressed
// from outside, and the production signature checked by its own updater. Nothing here is rebuilt
// or changed, and it needs no secrets.
//
//   PEAK_SMOKE_PLATFORM=... release-upgrade.mjs vOLD vNEW <output dir>
//
// With --rehearse, before vNEW exists: installs vOLD and shows the buttons can be pressed.
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { IS_WINDOWS, PLATFORM, cli, dataDir, install, join, liveApps, log, mkdirSync, mkdtempSync, pidAlive, tmpdir, shot, sleep, storedRun, waitFor, workload, writeFileSync } from "./lib.mjs"
import { closeApp, openApp, present, press, stopDriving } from "./drive.mjs"
import { runProbes } from "./probes.mjs"

const rehearse = process.argv.includes("--rehearse")
const [from, to, out] = process.argv.slice(2).filter((a) => a !== "--rehearse")
if (!from || !to || !out) throw new Error("usage: release-upgrade.mjs vOLD vNEW <output dir> [--rehearse]")
const FEED = "https://github.com/Noah-Wilderom/peak/releases/latest/download/latest.json"
const fromVersion = from.replace(/^v/, "")
const toVersion = to.replace(/^v/, "")
mkdirSync(out, { recursive: true })
const record = {}
const check = (name, ok, detail) => {
  record[name] = { ok: !!ok, detail }
  log(ok ? "ok  " : "FAIL", name, detail ?? "")
  if (!ok) process.exitCode = 1
}
const finish = async () => {
  await closeApp()
  stopDriving()
  writeFileSync(join(out, `release-upgrade-${PLATFORM}.json`), JSON.stringify({ from, to, rehearse, feed: FEED, record }, null, 2))
  log(process.exitCode ? "RELEASE UPGRADE FAILED" : rehearse ? "REHEARSAL OK" : "RELEASE UPGRADE OK")
  process.exit(process.exitCode ?? 0)
}
const installed = async () => (await cli(["version"]).done).out.trim()
/** Keep trying, as a notice can take a moment to appear. */
const pressWhenThere = (name, ms) => waitFor(`"${name}"`, async () => ((await press(name)) ? true : null), ms).catch(async (e) => {
  shot(out, `${PLATFORM}-missing-${name.replaceAll(" ", "-")}`)
  throw e
})

const announced = await fetch(FEED, { redirect: "follow" }).then((r) => r.json())
check("the feed announces what's expected", announced.version === (rehearse ? announced.version : toVersion), announced.version)
if (!rehearse && announced.version !== toVersion) await finish()

// Not in the output directory, which is uploaded.
const older = mkdtempSync(join(tmpdir(), "peak-older-"))
execFileSync(process.execPath, ["scripts/e2e/smoke/public-install.mjs", from, older], { stdio: "inherit" })
install(older)
const before = await installed()
check("the older release is installed, from its public files", before.includes(fromVersion), before)

await openApp()
const old = await waitFor("the older app", () => liveApps()[0])
await sleep(4000)
shot(out, `${PLATFORM}-older-app`)

if (rehearse) {
  await pressWhenThere("Settings", 60_000)
  await sleep(1500)
  await pressWhenThere("Check for updates", 30_000)
  const said = await waitFor("an answer from the update check", async () => (await present(announced.version === fromVersion ? (IS_WINDOWS ? "This is the latest version." : "latest version") : "Download and install")) || null, 60_000).catch(() => false)
  shot(out, `${PLATFORM}-rehearsal`)
  check("the production app's buttons can be pressed from outside, and it answers", said)
  await finish()
}

// A setting of the user's, and a run in history, to find again afterwards.
await closeApp()
await waitFor("the older app to close", () => !pidAlive(old.pid) || null, 30_000)
const db = new DatabaseSync(join(dataDir(), "peak.db"))
const settings = { retentionDays: 11, maxRuns: 77, alertsEnabled: true, notifications: false, alertMemoryMib: 777, alertCpuPercent: 0, alertCpuSeconds: 0, checkForUpdates: true }
db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings))
db.close()
await openApp()
const running = await waitFor("the older app again", () => liveApps()[0])
const historyId = `history-${Date.now()}`
const first = await cli(["run", "--", ...workload(historyId, 3, 5)]).done
check("a run recorded before the update", first.code === 5 && !/without monitoring/.test(first.err))
await waitFor("the first run stored", () => storedRun(historyId)?.exit_code === 5, 30_000)
const liveId = `across-${Date.now()}`
const across = cli(["run", "--", ...workload(liveId, 240, 9)])

// ─── the update, by its own buttons ────────────────────────────────────────
await pressWhenThere("Download and install", 120_000)
log("downloading and verifying")
await sleep(1000)
shot(out, `${PLATFORM}-downloading`)
await pressWhenThere("Restart now", 240_000)
shot(out, `${PLATFORM}-restarting`)
const fresh = await waitFor("the new release to relaunch", () => {
  const n = liveApps().find((i) => i.pid !== running.pid)
  return n && !pidAlive(running.pid) ? n : null
}, 240_000)
check("the older app exited and a new one started", fresh.pid !== running.pid, `${running.pid} -> ${fresh.pid}`)
const after = await installed()
check("this machine now runs the published release", after.includes(toVersion) && !after.includes("source build"), after)
await sleep(3000)
shot(out, `${PLATFORM}-after-upgrade`)

// ─── everything still there, and the new agents working ────────────────────
check("the workload from `peak run` survived the restart", across.child.exitCode === null)
const history = storedRun(historyId)
check("history survived", history?.exit_code === 5 && history.samples > 0, history && `samples ${history.samples}`)
const read = new DatabaseSync(join(dataDir(), "peak.db"), { readOnly: true })
const kept = JSON.parse(read.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value)
read.close()
check("settings survived", kept.maxRuns === 77 && kept.alertMemoryMib === 777, JSON.stringify(kept))
const postId = `post-${Date.now()}`
const post = await cli(["run", "--", ...workload(postId, 3, 6)]).done
check("the new app monitors the CLI", post.code === 6 && !/without monitoring/.test(post.err), post.err.split("\n")[0])
await waitFor("the new run stored", () => storedRun(postId)?.exit_code === 6, 30_000)
await runProbes({ check, record, out })
const end = await across.done
check("that workload finished with its own exit code", end.code === 9, `exit ${end.code}`)
await finish()
