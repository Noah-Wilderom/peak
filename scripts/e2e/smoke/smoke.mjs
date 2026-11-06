#!/usr/bin/env node
// Installs a platform's real artifact and uses it: version, collector, the app on its own, and
// a monitored run from a separate CLI process, checked in the terminal and in the app's database.
//   PEAK_SMOKE_PLATFORM=<linux|windows|darwin-aarch64|darwin-x86_64> smoke.mjs <artifacts dir> <output dir>
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { PLATFORM, cli, closeApps, install, join, launch, liveApps, log, mkdirSync, mkdtempSync, shot, sleep, storedRun, storedSamples, tmpdir, waitFor, workload, writeFileSync } from "./lib.mjs"

const [artifacts, out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const record = {}
const check = (name, ok, detail) => {
  record[name] = { ok: !!ok, detail }
  log(ok ? "ok  " : "FAIL", name, detail ?? "")
  if (!ok) process.exitCode = 1
}

install(artifacts)

const version = await cli(["version"]).done
const kinds = { linux: "AppImage", windows: "Windows installer", "darwin-aarch64": "macOS app", "darwin-x86_64": "macOS app" }
check("the installed copy says what it is", version.code === 0 && version.out.includes(kinds[PLATFORM]), version.out.trim())

const collector = await cli(["collector"]).done
log(`collector: ${collector.out.trim()} ${collector.err.trim()}`)
check("names its bundled collector", collector.code === 0, collector.out.trim())

const absent = await cli(["run", "--", "node", "-e", "process.exit(4)"]).done
check("with no app open, the command still runs and says why", absent.code === 4 && /isn't running/.test(absent.err), absent.err.trim())

launch()
const app = await waitFor("the app to publish itself", () => liveApps()[0])
log("app pid", app.pid)
await sleep(5000)
shot(out, `${PLATFORM}-app`)
check("the app stays open", liveApps().length === 1)

const envCheck = await cli(["run", "--", "node", "-e", "console.log(JSON.stringify(process.env))"]).done
const leaked = Object.entries(JSON.parse(envCheck.out.split("\n").find((l) => l.startsWith("{")) ?? "{}")).filter(([k, v]) => /\.mount_|^APPDIR$|^APPIMAGE$/.test(k) || /\.mount_/.test(v))
check("commands don't inherit the app's own environment", envCheck.code === 0 && leaked.length === 0, leaked.map(([k]) => k).join(",") || "clean")

const place = mkdtempSync(join(tmpdir(), "peak place "))
const where = await cli(["run", "--", "node", "-e", "console.log('cwd=' + process.cwd())"], { cwd: place }).done
const at = where.out.split("\n").find((l) => l.startsWith("cwd="))?.slice(4)
check("commands run where the CLI was started", at && realpathSync(at) === realpathSync(place), at)

const id = `smoke-${Date.now()}`
const c = cli(["run", "--", ...workload(id, 4, 7)])
const r = await c.done
check("output and exit code in the terminal", r.code === 7 && r.out.includes(`${id}-out`) && r.err.includes(`${id}-err`), `exit ${r.code}`)
check("monitored by the open app", !/without monitoring/.test(r.err), r.err.split("\n")[0])

const run = await waitFor("the run in the app's database", () => {
  const s = storedRun(id)
  return s && s.samples > 0 && s.exit_code !== null ? s : null
}, 30_000).catch((e) => (check("recorded", false, e.message), null))
if (run) {
  check("the app recorded real samples and the exit", run.exit_code === 7 && run.maxRss > 0 && run.samples > 2, `samples ${run.samples}, max rss ${run.maxRss}, exit ${run.exit_code}`)
}
// The runtime agents load inside the user's program, so these are real heap and lag figures.
const nodeSamples = storedSamples(id)
check("the Node agent reported from inside the program", nodeSamples.some((s) => s.heap > 0), `max heap ${Math.max(0, ...nodeSamples.map((s) => s.heap ?? 0))}`)

const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0)
if (python) {
  const pyId = `py-${Date.now()}`
  const script = join(mkdtempSync(join(tmpdir(), "peak-py-")), "work.py")
  writeFileSync(script, `import time\nprint("${pyId}", flush=True)\nend = time.time() + 5\nwhile time.time() < end:\n    sum(range(200000))\n    time.sleep(0.05)\n`)
  const py = await cli(["run", "--", python, script]).done
  await waitFor("the Python run stored", () => storedRun(pyId)?.exit_code === 0, 30_000).catch(() => {})
  const samples = storedSamples(pyId)
  check("the Python agent reported from inside the program", py.code === 0 && samples.some((s) => (s.loopLag ?? 0) > 0), `lag samples ${samples.filter((s) => s.loopLag !== undefined).length}`)
} else {
  log("no Python on this machine: its agent wasn't checked")
}
shot(out, `${PLATFORM}-after-run`)
closeApps()
writeFileSync(join(out, `smoke-${PLATFORM}.json`), JSON.stringify(record, null, 2))
log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK")
