#!/usr/bin/env node
// The real update path, end to end, against a published release: an older build, carrying the
// real update URL and the real public key, finds the release through GitHub's feed, downloads
// it, verifies the production signature, installs it and relaunches. Afterwards this machine is
// running the exact published release. Needs no secrets and publishes nothing.
//
//   PEAK_SMOKE_PLATFORM=... PEAK_PROOF_TARGET=<rust target> public-update-proof.mjs vX.Y.Z <output dir>
//
// The older build differs from a release only in its version, and in pressing the update buttons
// by itself, which is the one way to do this where no WebDriver exists (macOS). Its own updater
// artifacts are signed with a throwaway key made here, and are never served to anything.
//
// PEAK_PROOF_ENDPOINT and PEAK_PROOF_INSECURE point it at another feed, to rehearse this script.
import { execFileSync, execSync } from "node:child_process"
import { IS_WINDOWS, PLATFORM, cli, closeApps, install, join, launch, liveApps, log, mkdirSync, mkdtempSync, paths, pidAlive, proofFailures, readFileSync, shot, sleep, storedRun, tmpdir, waitFor, workload, writeFileSync } from "./lib.mjs"

const [tag, out] = process.argv.slice(2)
if (!tag || !out) throw new Error("usage: public-update-proof.mjs vX.Y.Z <output dir>")
const published = tag.replace(/^v/, "")
const BASE = "0.0.9"
const FEED = process.env.PEAK_PROOF_ENDPOINT ?? "https://github.com/Noah-Wilderom/peak/releases/latest/download/latest.json"
const FIRST_PASS_MS = 25_000
mkdirSync(out, { recursive: true })
const record = []
const check = (name, ok, detail) => {
  record.push({ name, ok: !!ok, detail })
  log(ok ? "ok  " : "FAIL", name, detail ?? "")
  if (!ok) process.exitCode = 1
}
const sh = (c, env = {}) => execSync(c, { stdio: "inherit", shell: IS_WINDOWS ? "bash" : "/bin/sh", env: { ...process.env, ...env } })

// The feed first: there's no point building if it isn't the release we mean.
const announced = await fetch(FEED, { redirect: "follow" }).then((r) => {
  if (!r.ok) throw new Error(`${r.status} from ${FEED}`)
  return r.json()
})
check("the feed announces the published version", announced.version === published, announced.version)
if (announced.version !== published) process.exit(1)

// ─── the older build ────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "peak-public-"))
const keyFile = join(work, "throwaway.key")
execFileSync(IS_WINDOWS ? "bun.exe" : "bun", ["x", "tauri", "signer", "generate", "--ci", "-w", keyFile, "-p", "proof-only"], { stdio: "ignore" })
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
const overlay = join(work, "overlay.json")
// The public key is the release's own, so only the real signature can pass.
writeFileSync(overlay, JSON.stringify(process.env.PEAK_PROOF_ENDPOINT ? { plugins: { updater: { endpoints: [FEED], ...(process.env.PEAK_PROOF_INSECURE ? { dangerousInsecureTransportProtocol: true } : {}) } } } : {}))
const target = process.env.PEAK_PROOF_TARGET
sh(`node scripts/release/version.mjs set ${BASE}`)
sh(`sh scripts/release/tauri-build.sh ${target ? `--target ${target}` : ""} --config "${overlay.replace(/\\/g, "/")}"`, {
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "proof-only",
  VITE_PEAK_E2E_AUTOUPDATE: String(FIRST_PASS_MS),
  PEAK_REQUIRE_COLLECTOR: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1",
})
const bundle = target ? `src-tauri/target/${target}/release/bundle` : "src-tauri/target/release/bundle"
const baseDir = join(work, "base")
sh(`node scripts/release/collect.mjs "${bundle}" "${baseDir.replace(/\\/g, "/")}" ${PLATFORM}`)
sh(`node scripts/release/version.mjs set ${conf.version}`)

// ─── install it, and leave history and a workload behind ───────────────────
const installedVersion = async () => (await cli(["version"]).done).out.trim()
install(baseDir)
const before = await installedVersion()
check("the older build is installed", before.includes(BASE), before)

launch()
const old = await waitFor("the older app", () => liveApps()[0])
const historyId = `history-${Date.now()}`
const first = await cli(["run", "--", ...workload(historyId, 3, 5)]).done
check("a run recorded before the update", first.code === 5 && !/without monitoring/.test(first.err))
await waitFor("the first run stored", () => storedRun(historyId)?.exit_code === 5, 15_000)
const liveId = `across-${Date.now()}`
const across = cli(["run", "--", ...workload(liveId, 90, 9)])

// ─── the update, through the real feed ─────────────────────────────────────
log(`waiting for ${BASE} to update itself from ${FEED}`)
const fresh = await waitFor("the published version to relaunch", () => {
  const n = liveApps().find((i) => i.pid !== old.pid)
  return n && !pidAlive(old.pid) ? n : null
}, 300_000).catch(async (e) => {
  log(`old app alive: ${pidAlive(old.pid)}; records: ${JSON.stringify(liveApps().map((i) => i.pid))}`)
  log(await installedVersion())
  log(`what the app said went wrong:\n${proofFailures().join("\n")}`)
  shot(out, "public-update-timeout")
  throw e
})
check("the older app exited and a new one started", fresh.pid !== old.pid, `${old.pid} -> ${fresh.pid}`)
const after = await installedVersion()
check("this machine now runs the published version", after.includes(published), after)
const failures = proofFailures()
check("nothing failed on the way", failures.length === 0, failures.join(" | "))
await sleep(3000)
shot(out, `${PLATFORM}-after-public-update`)

// ─── and everything still there ────────────────────────────────────────────
check("the workload from `peak run` survived the restart", across.child.exitCode === null)
const history = storedRun(historyId)
check("history survived", history?.exit_code === 5 && history.samples > 0, history && `samples ${history.samples}`)
const postId = `post-${Date.now()}`
const post = await cli(["run", "--", ...workload(postId, 3, 6)]).done
check("the published app monitors the CLI", post.code === 6 && !/without monitoring/.test(post.err), post.err.split("\n")[0])
await waitFor("the new run stored", () => storedRun(postId)?.exit_code === 6, 30_000)
const end = await across.done
check("that workload finished with its own exit code", end.code === 9, `exit ${end.code}`)
closeApps()

writeFileSync(join(out, `public-update-${PLATFORM}.json`), JSON.stringify({ tag, feed: FEED, record, paths: paths() }, null, 2))
log(process.exitCode ? "PUBLIC UPDATE FAILED" : "PUBLIC UPDATE OK")
process.exit(process.exitCode ?? 0)
