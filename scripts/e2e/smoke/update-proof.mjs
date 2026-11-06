#!/usr/bin/env node
// A real update between two packaged versions on this OS: two real builds, signed with a throwaway
// key made here, served from localhost. The release channel and its key aren't involved.
//   PEAK_SMOKE_PLATFORM=... PEAK_PROOF_TARGET=<rust target> update-proof.mjs <output dir>
// Works on a checkout it may change (versions, tauri.conf overlay is passed, not written).
//
// The proof builds set VITE_PEAK_E2E_AUTOUPDATE, which presses the update buttons on a timer, as
// there's no WebDriver on macOS. Everything underneath is the real plugin and real flow.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { createServer } from "node:http"
import { IS_WINDOWS, PLATFORM, cli, closeApps, install, join, launch, liveApps, log, mkdirSync, mkdtempSync, paths, pidAlive, proofFailures, readFileSync, readdirSync, shot, sleep, storedRun, tmpdir, waitFor, workload, writeFileSync } from "./lib.mjs"
import { buildPair } from "./build-pair.mjs"

const out = process.argv[2]
mkdirSync(out, { recursive: true })
const BASE = "9.0.0"
const NEXT = "9.0.1"
const PORT = 18765
const work = mkdtempSync(join(tmpdir(), "peak-proof-"))
const record = []
const check = (name, ok, detail) => {
  record.push({ name, ok: !!ok, detail })
  log(ok ? "ok  " : "FAIL", name, detail ?? "")
  if (!ok) process.exitCode = 1
}

// ─── build ──────────────────────────────────────────────────────────────────
const { baseDir, nextDir, artifactName, artifactBytes, goodSig, wrongKeySig, key } = buildPair({ work, BASE, NEXT, PORT, autoUpdate: true })

// ─── the feed ───────────────────────────────────────────────────────────────
let mode = "good"
let hits = { feed: 0, artifact: 0 }
const server = createServer((req, res) => {
  const feed = (version, signature, url = `http://127.0.0.1:${PORT}/${artifactName}`) =>
    JSON.stringify({ version, notes: "proof", pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), platforms: { [key]: { signature, url } } })
  if (req.url === "/latest.json") {
    hits.feed++
    if (mode === "error500") return void res.writeHead(500).end("no")
    if (mode === "malformed") return void res.writeHead(200).end("{ not json")
    const version = mode === "no-update" ? BASE : NEXT
    const signature = mode === "wrong-key" ? wrongKeySig : goodSig
    return void res.writeHead(200, { "content-type": "application/json" }).end(feed(version, signature))
  }
  hits.artifact++
  if (mode === "missing-artifact") return void res.writeHead(404).end()
  if (mode === "truncated") {
    res.writeHead(200, { "content-length": artifactBytes.length })
    res.write(artifactBytes.subarray(0, 1024 * 1024))
    return void setTimeout(() => res.destroy(), 200)
  }
  const bytes = mode === "tampered" ? Buffer.concat([artifactBytes.subarray(0, 4096), Buffer.from("tampered"), artifactBytes.subarray(4104)]) : artifactBytes
  res.writeHead(200, { "content-length": bytes.length }).end(bytes)
})
const serve = () => new Promise((r) => server.listen(PORT, "127.0.0.1", r))
const unserve = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) })

const installedVersion = async () => (await cli(["version"]).done).out.trim()
const installedHash = () => createHash("sha256").update(readFileSync(paths().gui)).digest("hex")

// ─── install the base and leave history behind ──────────────────────────────
install(baseDir)
const before = await installedVersion()
check("the base version is installed", before.includes(BASE), before)

launch()
await waitFor("the app", () => liveApps()[0])
const historyId = `history-${Date.now()}`
const first = await cli(["run", "--", ...workload(historyId, 3, 5)]).done
check("a run recorded before the update", first.code === 5 && !/without monitoring/.test(first.err), first.err.split("\n")[0])
await waitFor("the first run stored", () => storedRun(historyId)?.exit_code === 5, 30_000)

// ─── no server at all: the app keeps working ───────────────────────────────
await sleep(8000)
const offlineApp = liveApps()[0]
check("offline: the app keeps running", offlineApp && (await installedVersion()).includes(BASE))
closeApps()
await sleep(2000)

// ─── everything that must not change the install ───────────────────────────
await serve()
const hashBase = installedHash()
for (const [name, wants] of [
  ["no-update", { artifact: 0 }],
  ["error500", { artifact: 0 }],
  ["malformed", { artifact: 0 }],
  ["missing-artifact", {}],
  ["truncated", {}],
  ["tampered", {}],
  ["wrong-key", {}],
]) {
  mode = name
  hits = { feed: 0, artifact: 0 }
  launch()
  const app = await waitFor(`the app (${name})`, () => liveApps()[0])
  await waitFor(`a check (${name})`, () => hits.feed > 0 && (wants.artifact === 0 || true), 40_000)
  await sleep(name === "no-update" || name === "error500" || name === "malformed" ? 6000 : 15_000)
  const kept = installedHash() === hashBase
  check(`${name}: nothing installed, app alive`, kept && pidAlive(app.pid) && (wants.artifact !== 0 || hits.artifact === 0), `feed ${hits.feed}, artifact ${hits.artifact}`)
  closeApps()
  await sleep(2500)
}

// ─── the real thing, with a workload running throughout ────────────────────
await unserve()
mode = "good"
hits = { feed: 0, artifact: 0 }
launch()
const old = await waitFor("the old app", () => liveApps()[0])
const liveId = `across-${Date.now()}`
const across = cli(["run", "--", ...workload(liveId, 60, 9)])
await sleep(4000)
await serve()
log("feed up, waiting for the update")
const fresh = await waitFor("the updated app to relaunch", () => {
  const n = liveApps().find((i) => i.pid !== old.pid)
  return n && !pidAlive(old.pid) ? n : null
}, 300_000).catch(async (e) => {
  // What was going on, for whoever reads this log.
  log(`feed ${hits.feed}, artifact ${hits.artifact}; old app alive: ${pidAlive(old.pid)}; records: ${JSON.stringify(liveApps().map((i) => i.pid))}`)
  log(await installedVersion())
  shot(out, "update-timeout")
  log(`what the app said went wrong:\n${proofFailures().join("\n")}`)
  log(IS_WINDOWS ? spawnSync("tasklist", { encoding: "utf8" }).stdout : spawnSync("ps", ["aux"], { encoding: "utf8" }).stdout)
  log(readdirSync(dirname(paths().gui)).join(" "))
  throw e
})
check("downloaded from the feed", hits.artifact > 0, `feed ${hits.feed}, artifact ${hits.artifact}`)
check("the old app exited and a new one started", fresh.pid !== old.pid, `${old.pid} -> ${fresh.pid}`)
const after = await installedVersion()
check("the installed copy is the new version", after.includes(NEXT), after)
check("the workload from `peak run` survived the restart", across.child.exitCode === null)

// ─── after ──────────────────────────────────────────────────────────────────
const history = storedRun(historyId)
check("history survived", history?.exit_code === 5 && history.samples > 0, history && `samples ${history.samples}`)
const postId = `post-${Date.now()}`
const post = await cli(["run", "--", ...workload(postId, 3, 6)]).done
check("the new app monitors the CLI", post.code === 6 && !/without monitoring/.test(post.err), post.err.split("\n")[0])
await waitFor("the new run stored", () => storedRun(postId)?.exit_code === 6, 30_000)
const end = await across.done
check("that workload finished with its own exit code", end.code === 9, `exit ${end.code}`)
await unserve()
closeApps()
// Whether a `peak-cli` that was running got moved aside for the installer (Windows).
log(`installed files: ${readdirSync(dirname(paths().gui)).filter((f) => /peak-cli|^peak/.test(f)).join(" ")}`)

writeFileSync(join(out, `update-proof-${PLATFORM}.json`), JSON.stringify(record, null, 2))
log(process.exitCode ? "PROOF FAILED" : "PROOF OK")
process.exit(process.exitCode ?? 0)
